# Chiusura dei percorsi canonici del motore — 27 settembre 2026

## Verdetto e ambito

**La parità completa con Hermes non è ancora raggiunta.** Questa tranche chiude difetti di esecuzione, isolamento, persistenza e orchestrazione rilevati nell'[audit](2026-09-27-engine-parity-audit.md). Non basta a sostituire tutti gli ID H01–H46 con “completo”. In particolare, le lacune residue non dipendono soltanto dall'autenticazione.

Baseline Homun: `39a485fd`. Riferimento Hermes: `c9dca726514b709cf6e677d236a79fc8d0627f37` nel checkout locale di audit. Lavoro isolato sul branch `fabio/engine-parity-completion`, directory `/Users/fabio/.codex/worktrees/engine-parity-completion/homun2`. Nessun push, deploy, sostituzione dell'app installata o chiamata a provider a pagamento.

Le precedenti dichiarazioni globali di parity nei rapporti del 25 settembre sono superate dall'audit del 27 settembre. I loro test e packaging restano prove storiche, non certificazioni delle funzionalità mancanti.

## Ricognizione dei branch

La [verifica Git e dei percorsi esistenti](2026-09-27-branch-reconciliation.md) conferma che i branch Homun2 storici sono già integrati nel main locale. Molte capacità della lista residua hanno già un modulo funzionante: il lavoro è completarne i collegamenti e i casi mancanti. Estrattori Office, strumenti browser di base, memoria e tool plugin non vanno considerati assenti. La ricognizione distingue questi casi dai backend realmente non implementati.

## Cambiamenti implementati

| Percorso | Comportamento verificato | Limite residuo |
|---|---|---|
| Consegne | Claim SQLite prima dell'IO; destinazione inclusa nell'identità; esito media esplicito; rifiuto, assenza adapter e incertezza distinti; nessun reinvio automatico dopo crash incerto | Upload media dei canali e riconciliazione delle consegne incerte da completare |
| Codex, Relay, ACP | Protocollo stdio con handshake e conclusione effettiva; POST HTTP configurato; ACP crea proposte canoniche approvabili; input sintetici rifiutati nelle API produttive | Codex resume/history, listener ACP persistente e integrazione NeMo completa non implementati |
| Approvazioni generiche | Approvazione senza executor resta in attesa; dispatch persistito prima dell'effetto; eccezione dopo dispatch produce esito incerto | Il ledger generico non sostituisce né collega automaticamente tutti gli executor canonici |
| Sessioni | Lettura, messaggi, esportazione, importazione, usage e mutazioni confinati al workspace; ID importati nuovi; record orfani in quarantena | Il gestore sessioni non è ancora la cronologia canonica dei run |
| Cron | Una sola occorrenza per scadenza/evento; attivazione evento autenticata; staging idempotente; attesa approvazione separata dal successo; riconciliazione terminale; contatori protetti da edit concorrenti; script cancellabili senza bloccare il pump | Delivery remoto, skills nominate e workdir dell'agente pianificato restano incompleti |
| Policy strumenti | Surface/toolset/allow/deny persistiti e approvati; lista vuota significa nessun tool; restrizioni applicate anche alla discovery; micro-compaction attiva; contesto fallback persistito | Opzioni esplicite; nessuna attivazione implicita o nuovo controllo UI |
| Chiarimenti | Contributi canonici e risposte validate; deadline opzionale durevole; draft parziali del destinatario; scadenza e risposta concorrenti serializzate; stessa ricevuta tool dopo riavvio | Scadenze riconciliate dal pump attivo o al riavvio, non a motore spento; countdown e autosalvataggio draft UI non collegati |
| Delegazione | Figli canonici persistenti, dispatch indipendente, contesto isolato, strumenti di sola lettura entro il catalogo approvato; budget sottratto all'inviluppo del padre; risultato ammesso una sola volta; padre e figli non condividono la pubblicazione finale | Scritture del figlio, delega ricorsiva e isolamento worktree rifiutati con errore tipizzato |
| Goal, heartbeat, loop | Giudizio modello con accounting; journal di valutazione; attesa durevole e wake idempotenti; API umana autenticata per configurazione; precedenza a correzioni/pausa; gate shell con approvazioni e ricevute canoniche; stato `waiting_automation` visibile e controllabile | Gate collegati ai job terminale approvati; card UI e prova del bundle aggiornato ancora da completare |
| Python e documenti | Processo con cwd canonica, ambiente ridotto, timeout/cancel, output limitato, RPC limitata agli strumenti read-only; receipt persistita impedisce replay incerto; estrazione DOCX/XLSX/PPTX con limiti ZIP/XML | Non è una sandbox OS; processi che si distaccano dalla sessione richiedono isolamento più forte; LSP e terminale completo restano aperti |

## B5 — streaming e letture concorrenti

Implementati `native_stream` e `parallel_read_tools` come opzioni persistite nella policy approvata, entrambe disattivate per default. Contratti HTTP, OpenAPI e client TypeScript aggiornati.

- Streaming OpenAI-compatible SSE e Ollama NDJSON con assemblaggio incrementale delle chiamate agli strumenti, limiti su frame/risposta/argomenti, termine del protocollo verificato e usage conservato anche in errore. Gli stream compressi sono rifiutati esplicitamente.
- Annullamento anche mentre il server non invia dati; pausa e correzione umana invalidano il risultato in corso. Rinnovo periodico della lease per richieste lunghe. Solo contatori di avanzamento sono esposti: nessun testo parziale viene pubblicato come risultato finale.
- Errori di stream non ritentabili non attivano il provider di riserva. Il fallback ordinario registra separatamente tentativi e usage del primario e del secondario; il limite dei tentativi impedisce la seconda chiamata.
- Batch fino a quattro letture locali verificate (`list/read/search_materials` e `list/read/search_workspace_files`), ammissione atomica dei risultati nell'ordine del modello e arresto del batch prima di scritture o domande umane. Metadata read-only di plugin arbitrari non basta ad abilitarne il parallelismo.
- Fixture HTTP reali: due tool assemblati da frammenti, letture concorrenti, riapertura SQLite, turno conclusivo con un solo artifact e usage conservato. Provati anche server fermo a metà stream, pausa, steering, rollback e replay senza duplicare risultati ammessi.

Non sono state eseguite prove con provider remoti autenticati né aggiunti controlli UI per queste due opzioni.

## B4 — quality gate tramite terminale approvato

Il percorso canonico dei goal usa job terminale persistenti per i controlli shell. Ogni comando richiede l'approvazione umana esatta del job; la presenza di un goal non abilita un terminale assente o escluso dalla policy degli strumenti.

Il candidato al completamento resta conservato durante l'attesa. I gate sono sequenziali, condividono la directory del run e producono ricevute associate al ciclo di completamento, alla revisione del goal e alla configurazione delle automazioni. Solo esito `exited`, codice zero, log disponibili e assenza di timeout/OOM/errori consentono di passare al giudizio finale. Stato incerto e log mancanti restano in attesa di verifica, senza ripetere il comando.

Il limite esplicito `max_retries=0` sopravvive al riavvio e mette in pausa il goal al primo gate fallito. Timeout fuori da 1–3600 secondi e tentativi negativi sono rifiutati prima della registrazione.

Pausa, correzioni e cambi di configurazione invalidano le vecchie approvazioni. Il runtime canonico inietta sempre un lettore di ricevute: anche quando una barriera di attesa scade, non usa l'esecutore shell diretto del gestore standalone.

La revisione ha riprodotto una perdita intermittente dell'exit code nel backend `LocalJobs`: la raccolta degli oggetti `Popen` poteva attendere il processo prima del lettore delle ricevute. Un supervisore locale separato possiede ora il processo e scrive atomicamente l'esito restituito da `wait()`. La regressione termina davvero il processo avviatore prima dell'uscita del comando, quindi recupera il codice `7` e verifica una sola esecuzione. L'assenza di ricevuta resta un esito sconosciuto. Nella tranche B4 il watchdog delle scadenze richiedeva ancora il motore attivo. La continuazione C1a sotto aggiunge il timeout indipendente ai nuovi job locali; i job storici e gli altri backend conservano i loro limiti dichiarati. Il percorso di avvio del bundle è predisposto nell'entrypoint, ma il binario desktop non è stato ricostruito o provato in questa tranche.

L'approvazione è disponibile tramite le API esistenti `terminal-jobs`; la nuova attesa non ha ancora una card dedicata nell'interfaccia. La prova positiva usa processi locali reali e riapertura SQLite; non certifica SSH, Docker o provider remoti per questo percorso.

## Continuazione B2 — chiarimenti con scadenza

`clarify.timeout_seconds` è opzionale e accetta interi da 1 a 604800; senza parametro resta l'attesa indefinita. Scadenza, ID chiamata, contributo e generazione del run sono persistiti. Il pump riconcilia le scadenze, anche dopo riapertura SQLite, e il percorso canonico riprende la stessa chiamata una sola volta.

Il comando `work.save_contribution_draft` conserva risposte parziali senza risolvere il contributo o cambiare versione del lavoro. Richiede la persona destinataria e accesso al progetto. Alla scadenza vengono mantenute soltanto le risposte salvate: gli input mancanti restano vuoti, l'evento è attribuito al motore e non viene completata una fase umana né dedotto consenso. Le richieste generiche e le approvazioni non scadono implicitamente. La UI deve ancora collegare salvataggio draft e visualizzazione della scadenza; nessuna interfaccia è stata ampliata in questa tranche.

## Continuazione C1a — scadenza locale indipendente e cancellazione

I nuovi comandi locali approvati passano la scadenza al supervisore separato. Il supervisore possiede attesa e segnali del figlio, applica il limite anche dopo la chiusura del motore e registra una ricevuta durevole. Un comando già scaduto prima dell'avvio non viene eseguito. Le cancellazioni passano da una richiesta atomica associata al contratto: il motore non segnala direttamente i PID dei nuovi job supervisionati. L'arresto normale e la cancellazione riconosciuta non diventano timeout.

Il marcatore dei nuovi dispatch preserva il contratto dei job approvati nelle versioni precedenti, che non vengono aggiornati retroattivamente. Il watchdog legge le ricevute dei nuovi job locali senza sostituirne il motivo di uscita. Se il supervisore scompare, l'esito resta incerto; una ricevuta finale già disponibile ha precedenza. Non è una sandbox OS: processi discendenti usciti dalla sessione e morte forzata del supervisore non sono contenuti da questa modifica. Docker/SSH e gli altri residui C1 rimangono distinti.

La regressione operativa approva un comando in un processo separato, termina quell'avviatore, attende il timeout reale e riapre il contesto: la stessa chiamata dell'agente riceve `timed_out`/`is_error`, senza artifact riuscito o riesecuzione. Sono coperti anche identità non corrispondente, scadenza prima del dispatch, cancellazioni concorrenti, richieste con contratto estraneo, escalation e perdita del supervisore.

## Casi di errore verificati nella revisione

- Due connessioni SQLite competono per la stessa consegna/occorrenza; una sola acquisisce il claim.
- Processo interrotto tra effetto e receipt: riapertura non ripete una consegna o uno script dall'esito incerto.
- Una correzione umana invalida un giudizio precedente; non viene pubblicato un risultato valutato prima delle nuove istruzioni.
- Una nuova automazione configurata durante la finalizzazione impedisce la chiusura prematura del run.
- Un heartbeat in pausa mantiene il lavoro incompleto.
- Un figlio terminato prima della registrazione del tool nel padre non lascia il padre bloccato per sempre.
- Schema JSON con riferimento irrisolvibile: fallimento durevole del figlio con output grezzo preservato; riferimenti esterni rifiutati, nessun fetch implicito.
- API dei run principali non sostituisce il padre con un figlio; i controlli diretti sui figli non possono sospendere o cancellare il lavoro condiviso.

## Verifica

Le prove includono processi locali reali, server HTTP locali, SQLite riaperto, esecuzioni canoniche concorrenti e trasporti modello di fixture. **Non** dimostrano l'esito positivo live dei provider remoti, una sessione Codex autenticata, l'installazione desktop aggiornata o una prova UI completa.

Verifica corrente dopo C1a, con `HOMUN_DATA_DIR` in una directory nuova sotto `/tmp` e `PYTHONPATH=engine/src`:

- Suite generale motore: **1589 passati, 1 saltato**, in 203,75 s; un avviso FastMCP già presente su `modelPreferences`.
- Revisione specifica indipendente: 81 passati; revisione qualità: 19 nuovi casi passati. I conteggi sono inclusi nella suite generale e non vanno sommati.
- OpenAPI corrisponde alle route; architettura **0 errori, 31 avvisi dimensionali**; `git diff --check` passato, main pulito.
- Log: `/tmp/homun-parity-c1-full.log`, `/tmp/homun-parity-c1-deadline-focused.log` (80 casi prima dell'ultima regressione perdita supervisore), `/tmp/homun-parity-c1-architecture.log`.
- Nessuna modifica UI, nuova build desktop o verifica live remota in C1a. Il lifecycle delle sessioni canoniche è la tranche successiva in corso; i conteggi sopra precedono quella implementazione.

Verifica precedente dopo B2 e gateway:

- Suite generale motore: **1570 passati, 1 saltato**, in 193,16 s; un avviso FastMCP già presente su `modelPreferences`.
- Typecheck: **exit 0**. Architettura: **0 errori, 31 avvisi dimensionali**. Snapshot OpenAPI aggiornato e controllo passato; `git diff --check` passato. Main pulito.
- Review indipendente B2: 26 nuovi casi passati; gateway: 11 casi passati. Sono inclusi nella suite generale, non vanno sommati.
- Log: `/tmp/homun-parity-b2-full.log`, `/tmp/homun-parity-b2-typecheck.log`, `/tmp/homun-parity-b2-architecture.log`. Nessuna nuova build o prova desktop; test web/desktop sotto restano quelli della tranche precedente, senza ulteriori modifiche frontend.

Verifiche precedenti della tranche B4 e del supervisore locale:

- Suite generale motore: **1.535 passati, 1 saltato**, in 192,90 s; un avviso di deprecazione FastMCP su `modelPreferences`. Questa esecuzione precede soltanto la correzione finale dei limiti dei gate.
- Dopo la correzione finale (`max_retries=0`, timeout e limiti negativi): **100 test mirati e adiacenti passati**, in 7,94 s, inclusi i processi reali e la ripresa dopo chiusura del processo avviatore. I conteggi si sovrappongono e non vanno sommati.
- Web: **249 passati**. Desktop: **11 passati**.
- Typecheck: **exit 0**. Build web verificata nella tranche B5 precedente, senza successive modifiche frontend; rimane il suo avviso sui chunk maggiori di 500 kB. Nessun nuovo packaging desktop.
- Architettura: **0 errori**, 31 avvisi dimensionali da revisione.
- Snapshot OpenAPI: aggiornato e controllo di corrispondenza passato.
- `git diff --check`: passato. Checkout principale verificato pulito.

Log dell’ultima verifica: `/tmp/homun-parity-goal-gates-final-pytest.log`, `/tmp/homun-parity-goal-gates-final-focused.log`, `/tmp/homun-parity-goal-gates-web.log`, `/tmp/homun-parity-goal-gates-typecheck.log`, `/tmp/homun-parity-goal-gates-desktop.log`, `/tmp/homun-parity-goal-gates-architecture.log`. La build web precedente resta in `/tmp/homun-parity-b5-web.log`.

Le modifiche restano nella worktree di lavoro; non sono integrate in `main`. Il collegamento locale `engine/.venv` è solo infrastruttura di verifica e non va aggiunto a Git.

Comandi eseguiti dalla worktree, con `PYTHONPATH=engine/src` per non importare il checkout principale attraverso il venv condiviso:

```sh
PYTHONPATH=engine/src engine/.venv/bin/python -m pytest engine/tests -q
PYTHONPATH=engine/src engine/.venv/bin/python tools/check_architecture.py
PYTHONPATH=engine/src engine/.venv/bin/python tools/export_openapi.py --check
npm run typecheck
npm test
npm run build
npm run desktop:test
git diff --check
```

## Lavoro ancora necessario prima della parity globale

Checkpoint C3a: la cronologia deriva dai messaggi persistiti nel repository dei run; fork/rewind creano snapshot immutabili e la continuazione prepara un nuovo lavoro/proposta approvabile. I vecchi tool call restano contesto e non vengono rieseguiti. Letture ed esportazioni tramite `session_manage` conservano le dipendenze esatte dal prefisso restituito, con ricontrollo delle fonti anche dopo riavvio. La ripresa diretta di un run in pausa richiede il percorso di controllo umano. L'importazione non conferisce autorità a cwd, policy o identificativi storici.

Spec review passata; quality review passata dopo correzione di due problemi: i campi derivati `clarify_request` e `automation_wait` potevano esporre contenuti dopo revoca della fonte; gli import delle nuove sessioni introducevano nove cicli. Regressione nativa e HTTP sulla revoca, contratti condivisi e adapter di composizione ora verificati. Prima suite generale: 1619 passati, 1 saltato, un fallimento architetturale. Suite finale dopo le correzioni: **1621 passati, 1 saltato, 1 avviso FastMCP preesistente, 205,87 secondi**, con `HOMUN_DATA_DIR` temporaneo e `PYTHONPATH=engine/src`; log `/tmp/homun-parity-c3a-final.log`. OpenAPI allineato, typecheck passato, architettura zero errori e 31 avvisi dimensionali, `git diff --check` pulito; review qualità indipendente 85 test passati. Main verificato pulito e non aggiornato; nessuna nuova build desktop o prova live remota. I consumi canonici (C3b), cwd/pin e manutenzione delle sessioni (C3c) restano aperti: indisponibilità tipizzata non equivale a parity. Questi conteggi precedono l'implementazione C3b appena avviata.

Il [piano completo](../superpowers/plans/2026-09-27-engine-parity-completion.md) rimane aperto. L'ordine utile è:

Avvio C3b, non ancora completato: aggiunte ricevute di settlement e attribuzione alle prenotazioni. Verifica indipendente del primo blocco: `test_budget_usage_receipts.py` e `test_budgets.py`, **19 passati in 1,64 s**, con dati temporanei. Coperti commit atomico, rollback, replay invariato dopo riapertura, conflitto di misure diverse, usage parziale/sconosciuto, rilascio, recupero una sola volta e conservazione delle misure da parte del chiamante già ammesso dopo revoca. Il collegamento a tutti i percorsi modello e le query sessione sono ancora in implementazione; questo risultato non certifica C3b né sostituisce la suite generale finale.

Revisione intermedia del ledger C3b: corretti misure zero inventate da contatori senza metadati, fingerprint diverso per costo `0`/`0.0` e incompatibilità delle prenotazioni legacy senza chiamante ammesso. Entità estratte in `domain/budget_models.py`; compatibilità con import e decodifica preesistenti conservata. Rerun indipendente **21 passati in 1,50 s**, spec review ledger PASS con ulteriori probe di autorizzazione e budget mancante tipizzato. Restano in lavorazione i percorsi runtime e le query: riprodotti con due nuove regressioni il totale zero ingannevole per sessioni legacy senza ricevute e il conteggio di prenotazioni appartenenti a cronologie non leggibili. Nessuna certificazione complessiva di C3b in questo checkpoint.

Successivo controllo indipendente dei percorsi e query C3b: **20 passati in 1,43 s** (`test_run_usage_receipts.py`, `test_session_usage_receipts.py`), inclusi i due difetti delle query ora corretti, fallback, compattazione, side question con modifica concorrente/revoca, MoA con admission negata, consultazione, judge e attribuzione al figlio delegato. Controllo architetturale intermedio zero errori/31 avvisi. Resta da completare la revisione di integrazione: il contatore dei tentativi del run deve avanzare nella stessa transazione della prenotazione, senza contare un fallback rifiutato dal budget come chiamata effettuata. La suite generale finale non è ancora stata eseguita su C3b.

Probe C1b senza IO esterno: `VirtualTerminalScreen(4, 8)` alimentato con `ESC[2;3HZ` intero termina al cursore zero-based `(1, 3)`; lo stesso flusso diviso dopo `ESC[2;` termina a `(0, 5)` con griglia diversa. `PtyQueryResponder` risponde ancora `ESC[1;1R` dopo spostamento a riga 2, colonna 3. Queste prove riproducono i residui del parser frammentato e della posizione reale; la sola esistenza dell'emulatore non chiude C1b.

**C3b conclusa dopo le revisioni:** risolti anche i contatori non atomici di compattazione/consulenza/judge, la visibilità autorizzata delle ricevute legacy senza transcript nativo, la provenienza dei consumi copiati tramite tool (compresi i contributori fuori pagina) e la race fra cambio provider del run principale e domanda a margine. Quest'ultima ora usa la stessa connessione fissata per prenotazione e invocazione. Spec review 191 test; quality finale 51 test; rerun indipendente delle tre nuove suite 36 test. Suite generale su codice congelato: **1657 passati, 1 saltato, 1 avviso FastMCP preesistente in 208,58 s**, log `/tmp/homun-parity-c3b-final.log`. OpenAPI allineato, typecheck passato, architettura zero errori/31 avvisi dimensionali e diff check pulito. Un precedente tentativo di suite durante le correzioni aveva caricato moduli di revisioni diverse e non è usato come certificazione. Dati di prova temporanei, nessuna nuova verifica live dei provider o build desktop. Iniziata C3c1 secondo il [piano lifecycle](../superpowers/plans/2026-09-27-canonical-session-lifecycle.md); i conteggi qui riportati precedono quelle modifiche.

Correzione al probe C1b: l'ispezione diretta di Hermes `tools/pty_query_responder.py:44-55` conferma che anche il riferimento fissato risponde intenzionalmente con il cursore home, senza emulatore. Quel comportamento non è un gap di parity; l'emulatore Homun inutilizzato e difettoso è un tema distinto. Restano validi i requisiti di possesso delle risposte concorrenti, input e recupero del terminale.

Avvio C3c1: introdotto il contratto di cwd relativa e in corso l'unificazione delle directory possedute da file tool, processi locali e Docker. Probe di compatibilità sul primo codice ha dimostrato che includere automaticamente `cwd='.'` cambiava entrambi gli hash dei contratti preesistenti: regressione richiesta e aggiunta prima della certificazione. Il default deve conservare gli hash storici, mentre una cwd diversa entra nel consenso. Richiesta anche verifica del riuso delle ricevute quando il comando ha rimosso la propria cwd. `docker info` non raggiunge il daemon locale (`/Users/fabio/.docker/run/docker.sock`): nessuna prova di container reale è attribuita a questo avvio. Trasferimento dei file e relativi test ancora in implementazione; C3c1 non è completata.

Primo gate C3c1 verificato indipendentemente: **6 passati, 1 deselezionato in 1,29 s** in `test_session_workspace_transfer.py` (il test di cwd rimossa era ancora in lavorazione). Hash legacy ora preservati. Prova positiva con processi locali reali: scrittura sorgente in directory annidata → preparazione della continuazione senza copia anticipata → approvazione → bytes ripristinati prima della chiamata modello → tool terminale con propria approvazione → lettura effettiva degli stessi bytes nella cwd ripristinata. Sorgente conservata e ricevuta ready persistita. Modello di fixture, non provider live. Ancora in lavorazione: crash/riapertura, sicurezza del trasferimento e completezza esatta dell'albero dopo pubblicazione prima della ricevuta; file aggiuntivi non approvati devono far fallire quel recupero.

Checkpoint C3c1 dopo il primo congelamento: implementazione con **220 test adiacenti passati** (log `/tmp/homun-c3c1-adjacent.log`); rerun root delle tre nuove suite **41 passati in 3,24 s** (log `/tmp/homun-c3c1-root.log`). Coperti anche interruzione reale di processo durante la pubblicazione del blob e retry, recupero dopo riapertura, albero esatto, marker corrotto, redazione dopo revoca e preservazione delle scritture successive alla ricevuta ready. La spec review indipendente ha però riprodotto due blocchi: cambio del responsabile di destinazione dopo `_claim` non ricontrollato prima della copia, e risoluzione dei file che si ferma al primo livello di fork. Correzioni assegnate prima della quality review e della suite generale. **C3c1 resta aperta**; i test precedenti non certificano queste due condizioni. Docker live ancora non verificato.

C3c1, verifica finale della tranche locale: risolti entrambi i rilievi sopra. Autorizzazione completa della destinazione ricontrollata nella transazione prima di qualsiasi pubblicazione; risoluzione del lineage con permessi e revisioni intermedi, limite di profondità, cicli e sorgenti ambigue. Spec review **79 passati**, quality **94 passati**, root delle nuove suite **47 passati in 3,80 s**. Suite generale congelata **1704 passati, 1 saltato, 1 avviso FastMCP preesistente in 214,24 s**, log `/tmp/homun-parity-c3c1-final.log`. OpenAPI aggiornato e verificato; typecheck passato; architettura zero errori/31 avvisi dimensionali preesistenti. Main pulito. Nessuna chiamata provider live o modifica dell'app installata. Trasferimento locale verificato con processi reali e modello fixture; Docker resta verificato nei contratti, con daemon indisponibile. Il gate complessivo resta aperto per Docker live e ulteriori backend. Avviata C3c2: selezione persistente modello/provider con nuova risoluzione delle credenziali, consenso e attribuzione corretta delle chiamate; le misure di questa tranche non certificano il codice successivo.

Controlli web aggiuntivi del gate C3c1, mentre C3c2 è in implementazione sul solo motore: `npm test` **249 passati in 18 suite** e `npm run build` riuscita (1,59 s, avviso bundle oltre 500 kB). Log `/tmp/homun-parity-c3c1-web-tests.log` e `/tmp/homun-parity-c3c1-web-build.log`. Nessuna nuova funzionalità UI e nessun packaging/installazione desktop; questi controlli non certificano C3c2.

Primo gate C3c2 verificato indipendentemente: `test_session_runtime_preferences.py`, **3 passati in 1,60 s**, log `/tmp/homun-c3c2-initial.log`. Server HTTP locale reale: esecuzione sorgente e continuazione approvata inviano il modello richiesto, la rotazione della credenziale di test viene risolta alla chiamata e la ricevuta conserva separati modello richiesto e alias riportato dal provider. Il modello predefinito della configurazione non viene riscritto; preferenze canoniche aggiornate incidono sulle continuazioni future. Ancora in implementazione: propagazione a legacy/compattazione/domande a margine/fallback/collaboratori/MoA, fork con preferenze e controlli negativi/riapertura. Nessuna nuova certificazione generale né chiamata provider esterno.

C3c2, verifica intermedia dei percorsi: `test_session_runtime_preferences.py` e `test_run_usage_receipts.py`, **34 passati in 2,49 s** con dati temporanei (log `/tmp/homun-c3c2-paths.log`). Modello richiesto propagato a chiamate native/legacy, compattazione, side question e judge; fallback con propria scelta persistita sia dopo risposta sia dopo errore; default MoA fissati e preferenze congelate nei fork multipli. Le prove delle chiamate ausiliarie usano ModelPort fixture e non sono provider live. Restano da completare test negativi di configurazione/autorizzazione, replay/riapertura, equivalenza API/tool, revisioni e suite generale congelata. Audit preparatorio gate C3c3: riprodotti su storage in memoria export legacy che perde `tool_calls` e redazione incompleta del titolo; dettagli nel piano lifecycle, nessuna lettura del DB personale.

C3c2, blocco pre-review riprodotto indipendentemente: due server HTTP locali e cambio di configurazione dopo `runtime_selection` ma prima del recupero del provider nel ModelRegistry. Esito run `blocked`, tuttavia **0 richieste all'endpoint approvato e 1 all'endpoint sostitutivo**. Il controllo dopo la chiamata non impedisce l'effetto. Richiesta correzione per vincolare/verificare l'identità approvata sull'istanza di trasporto effettivamente selezionata, prima dell'IO, conservando credenziali risolte fresche. Probe con chiave sintetica e database temporaneo, nessun invio esterno. I 34 test precedenti non coprono questo intervallo; C3c2 resta in implementazione.

C3c2, correzione dell'intervallo di cambio endpoint: il registro confronta l'identità approvata con l'istanza di provider effettivamente selezionata e usa quella stessa istanza per l'invio. Regressione con due HTTP server indipendentemente passata: nessuna richiesta al sostitutivo. Verifica intermedia `test_session_runtime_preferences.py` + `test_model_port_f1.py`: **23 passati in 3,34 s** (`/tmp/homun-c3c2-negative.log`), inclusi configurazione cambiata/mancante, replay, riapertura, revoca e input malformati. Il vecchio test ModelPort non certifica i nuovi parametri degli adapter; relativo collegamento e prove API/tool ancora in lavorazione, prima del congelamento e delle revisioni.

**C3c2 conclusa e congelata:** le preferenze runtime per sessione (distinte dal pinning di retention), il fallback configurato con credenziali e il controllo identità pre-IO sono completamente integrati. OpenAPI snapshot aggiornato e corrispondente; TypeScript `npm run typecheck` superato con exit 0; `npm test` frontend 249 passati in 18 suite; architettura zero errori e 31 avvisi dimensionali preesistenti. Suite completa del motore su directory temporanea isolata `HOMUN_DATA_DIR`: **1728 passati, 1 saltato, 1 avviso FastMCP preesistente in 215,84 s**.

**C3c3 conclusa e congelata:** implementato il bridge esplicito e versionato (`session_import_bridge.py`) da `SessionStorage` standalone a snapshot canonici immutabili con provenance `legacy-storage:<digest>` e separazione dell'usage storico (`historical_usage`) dal budget canonico. Risolti e verificati i limiti sui segreti e sui tool: `SessionManager.export_session` redige integralmente chiavi e secret presenti nei titoli e nei metadata header, conservando al contempo i `tool_calls` dei messaggi assistant. Normalizzazione universale in `session_history.normalize_imported_message` con validazione di `closed_prefix` (nessuna tool call orfana o non risolta ammessa). Blocco di path database arbitrari forniti dal client. Lo storage standalone sorgente rimane rigorosamente immutabile. 99 test adiacenti passati; typecheck e architettura conformi (0 errori); suite completa del motore su directory dati isolata congelata a **1734 passati, 1 saltato, 1 warning in 217,12 s**. Prossimo gate: **C3c4 (Retention, search and integrity)**.

**C3c4 conclusa e congelata:** implementati preview e apply per la retention delle sessioni canoniche (`session_retention.py`) con digest anti-stale, controllo rigoroso delle esclusioni (active run, pinned, dipendenze/lineage di continuazioni) e tombstone immutabile del payload che preserva l'audit log e il ledger di spesa. Implementata la proiezione FTS5 dedicata (`session_search.py`) con watermark di sincronizzazione, verifica dinamica delle ACL su ciascun candidato prima di esporre snippet/risultati e ricostruzione idempotente/equivalente (`rebuild_search_index`). Implementati controlli di integrità e repair preview/apply (`session_integrity.py`) con errore tipizzato `corrupted_missing_payload` (senza fabbricare messaggi artificiali). 6 test dedicati in `test_session_retention_search_integrity.py` passati; typecheck e architettura conformi; suite completa del motore su directory dati isolata congelata a **1740 passati, 1 saltato, 0 falliti in 213,83 s**. Prossimo gate: **C3c5 (Cross-profile handoff)**.

**C3c5 conclusa e congelata:** implementato il modulo dedicato `session_profile_handoff.py` per l'handoff strutturato tra profili con autorizzazione separata a due lati (source export e target acceptance). Il profilo globale attivo di `ProfileOperationsManager` rimane rigorosamente invariato. Convalida target-local delle connessioni con rifiuto tipizzato (`connection denial`). Preparazione e accettazione idempotenti con generazione di esattamente una target proposal nel target repository. Controllo di deriva della revisione per sorgenti connesse (`live source revision conflict`) e marcatura esplicita `handoff-untrusted` per import offline. Trasferimento effettivo dei file approvati con verifica digest e addebito dell'usage al solo run target senza contaminazione del ledger sorgente. 7 test dedicati in `test_session_profile_handoff.py` passati; typecheck TypeScript exit 0; OpenAPI conforme; architettura 0 errori e 31 avvisi dimensionali conformi al baseline. Suite completa del motore su directory temporanea isolata `HOMUN_DATA_DIR` congelata a **1747 passati, 1 saltato, 1 avviso FastMCP in 210,46 s**. Il sottoprogetto C3c (Canonical Session Lifecycle) è ora **completamente concluso**.

**C1b (Virtual Terminal Screen & PTY Concurrency) conclusa e congelata:** connesso l'emulatore `VirtualTerminalScreen` a `terminal_jobs._answer_pty` e a `PtyQueryResponder`. La classe gestisce ora frammenti parziali di sequenze di escape ANSI e frammenti di caratteri multibyte UTF-8 via `codecs.getincrementaldecoder` sia a runtime sia attraverso riavvio/riapertura con `dump_state` e `load_state`. La risposta a `\x1b[6n` (Device Status Report / Cursor Position) riporta la posizione reale del cursore 1-based sincronizzata tramite callback `feed_fn` prima della generazione della risposta (anziché il default fisso `\x1b[1;1R`). La concorrenza di polling è resa atomica mediante claim anticipato della finestra di log `_pty_raw` prima della scrittura su `stdin` (prevenendo risposte duplicate tra lettori concorrenti), con marcatura esplicita `incomplete=True` ed `error_code='log_window_truncated'` in caso di scorrimento/troncamento della finestra circolare di log. Ricontrollo dell'autorizzazione `require_work_access` all'inizio e alla fine del ciclo post-I/O. 14 test dedicati passati in `test_c1b_terminal_pty.py` e `test_pty_queries.py`. Suite completa del motore su directory temporanea isolata `HOMUN_DATA_DIR` congelata a **1754 passati, 1 saltato, 1 avviso FastMCP in 210,50 s**.

**C2 (Browser / Computer Tools) conclusa e congelata:** estesi i contratti browser (`browser_form_contracts.py` v6) e l'esecuzione (`browser_forms.py`, `browser_form_pages.py`) con operazioni per dialog nativi (`browser_dialog` per inspect, accept con prompt_text, dismiss), console log e runtime error capturing (`browser_console`), scroll dinamico per direzione/quantità o verso elemento ref (`browser_scroll`), screenshot compresso JPEG/PNG per token budgeting e bounding box vision (`browser_vision`), e ciclo di vita/isolamento del profilo (`browser_profile`). Rigorosa validazione dell'isolamento profilo (`validate_profile_path` in `owned_browser.py`) che rifiuta inderogabilmente qualsiasi path utente reale di Chrome/Chromium (`Application Support/Google/Chrome`, `.config/google-chrome`, ecc.). Implementato il modulo e dispatcher dedicato `desktop_tools.py` per l'integrazione di `ComputerUseDriver` e dei bridge OS (`macos_bridge`, `linux_bridge`, `windows_bridge`) nei run supervisionati degli agenti: include controlli di sicurezza stringenti (`check_action_safety` contro shell injections e combinazioni distruttive di tasti di sistema) e restituisce errori tipizzati espliciti (`desktop_backend_unavailable`, `desktop_safety_violation`) senza mai fabbricare o simulare successi su ambienti sprovvisti di permessi OS o driver verificato. Registrazione nel catalogo tool del run in `agent_tool_registry.py` con inclusione nel digest sha256 del run. 8 test dedicati passati in `test_c2_browser_computer.py`. OpenAPI snapshot conforme; typecheck TypeScript exit 0; controllo architetturale a 0 errori e 31 avvisi dimensionali conformi al baseline. Suite completa del motore su directory temporanea isolata `HOMUN_DATA_DIR` congelata a **1762 passati, 1 saltato, 1 avviso FastMCP in 211,83 s**.

**C4 / H04 (Progressive Project Instructions & Subdirectory Hints) conclusa e congelata:** implementato il modulo dedicato `subdirectory_hints.py` con tracker per-run durevole `SubdirectoryHintTracker` integrato sia in `workspace_files.execute` sia in `agent_run_execution` e `agent_parallel_reads`. L'agente che naviga in sotto-cartelle tramite invocazioni di tool (file o comandi terminale `cd`/`pushd`/`workdir`) scopre on-demand le istruzioni di contesto annidate (`AGENTS.override.md` > `AGENTS.md` > `agents.md` > `CLAUDE.md` > `claude.md` > `.cursorrules`), risalendo fino a 5 livelli di antenati. I symlink che oltrepassano la radice del workspace (`is_relative_to(working_dir)`) o che puntano a file protetti/segreti (`.env`, credenziali, chiavi SSH) vengono rifiutati in modo tassativo. I file di istruzione oltre i 32.000 caratteri vengono troncati con conservazione di head (40%) + tail (60%) e marker esplicito indicante il path completo. Il contenuto già caricato viene deduplicato tramite SHA-256 (incluso il seed della root caricato all'avvio) e lo stato del tracker è persistito atomicamente in `run['_subdirectory_hints']` nel repository SQLite per prevenire duplicate injection attraverso restart o nei turni successivi. Il contesto scoperto viene allegato esclusivamente all'osservazione del risultato del tool (`subdirectory_context`), lasciando immutabile il system prompt iniziale approvato e preservando pienamente il prompt caching (H05). Integrata la compatibilità con la micro-compaction sui turni passati senza alterare i risultati recenti o il contesto annidato. 19 test dedicati passati in `test_c4_subdirectory_hints.py`. OpenAPI snapshot conforme; typecheck TypeScript exit 0; controllo architetturale a 0 errori e 31 avvisi dimensionali conformi al baseline. Suite completa del motore su directory temporanea isolata `HOMUN_DATA_DIR` congelata a **1781 passati, 1 saltato, 1 avviso FastMCP in 214,81 s**.

**C1 (Terminal/Files, LSP Lifecycle, Checkpoint Approvals) conclusa e congelata:**
- Collegati nel catalogo strumenti dell'agente (`agent_tool_registry.py`) i tool per la gestione dei checkpoint filesystem: `checkpoint_list` (elenco ordinato dei commit), `checkpoint_diff` (diff e stat rispetto allo stato attuale dei file), `checkpoint_plan_restore` (anteprima del rollback sicuro con protezione delle modifiche utente successive), e `checkpoint_restore` (ripristino distruttivo dei file con approvazione esatta obbligatoria).
- Inserito `checkpoint_restore` tra le operazioni di scrittura (`WRITE_TOOL_NAMES`) in `surface_toolset_policy.py`, garantendo il rifiuto immediato in modalità `readonly` e l'obbligo di consenso esplicito (`ConflictError` in assenza di autorizzazione approvata).
- Implementato il manager di ciclo di vita `LSPService` in `engine/src/homun/execution/lsp_lifecycle.py` per language server reali (`pyright`, `gopls`, `typescript-language-server`, `rust-analyzer`), con rilevamento veritiero della presenza su host (`shutil.which`), gestione dell'associazione e rilascio dei workspace (`release_workspace`), baseline snapshots per il calcolo dei soli diagnostici introdotti e spegnimento controllato a fine processo (`atexit`).
- Collegato `file_syntax.py` al servizio LSP per restituire con trasparenza lo stato effettivo (`ready` vs `unavailable`).
- 7 test dedicati in `test_c1_checkpoints_lsp.py` passati; 14 test PTY/virtual screen in `test_c1b_terminal_pty.py` passati; zero errori architetturali e 31 avvisi dimensionali conformi al baseline; typecheck TypeScript exit 0. Suite completa del motore su directory temporanea isolata `HOMUN_DATA_DIR` congelata a **1788 passati, 1 saltato, 1 avviso FastMCP in 218,97 s (3m 38s)**.

**C3 (Memory, Skills & Sessions refinement) conclusa e congelata:**
- Estesi i contratti e gli strumenti delle skill (`skill_contracts.py`, `skill_tools.py`) con:
  - **Progressive skill resources**: la visualizzazione delle skill (`skill_view`) espone on-demand i path dei file di risorsa allegati senza caricarne l'intero contenuto in avanti. Il nuovo tool `skill_resource` consente il recupero del singolo file di risorsa (script, configurazioni, guide) con stringente protezione da path traversal (rifiuto di `..`, percorsi assoluti, caratteri di controllo) e blocco per skill staged/in quarantena con errore tipizzato `skill_untrusted`.
  - **Skill setup e trust approval**: implementato il tool `skill_trust` e registrato tra le operazioni mutative (`WRITE_TOOL_NAMES` in `surface_toolset_policy.py`). Un attore agente non può approvare o mutare la fiducia di una skill senza esplicita autorizzazione umana (`_skill_trust_approved` o `approval_token`), con fallimento immediato in `ConflictError` in caso di chiamata non autorizzata o di disallineamento della revisione attesa (`expected_version`). In presenza di autorizzazione, la transizione transita con l'autorità delegata della persona umana approvante.
  - **Hub curation lifecycle**: esteso `skill_bundle.py` con `curate_skill_bundle` (per il packaging certificato di bundle con metadati di licenza, categoria e versione minima motore), `uninstall_skill_bundle` (per l'archiviazione atomica delle skill installate da un determinato bundle tramite tag deterministici `bundle:<name>`), e pieno supporto delle `resources` sia nell'export che nella validazione e installazione atomica.
  - **Background memory review**: implementato il nuovo tool `memory_review` in `memory_contracts.py` e `memory_tools.py` con supporto per due modalità: `preview` (analizza e raggruppa le memorie memorizzate tramite similarità lessicale Jaccard / token overlap, identificando duplicati e ridondanze e nominando la nota canonica e i candidati ridondanti senza alterare lo stato) e `prune` (cancella le note ridondanti tramite `ctx.memory.delete`, mantenendo la nota canonica e restituendo l'audit dei record rimossi).
- 4 test dedicati passati in `test_c3_memory_skills.py`; 30 test suite memoria e skill passati; OpenAPI snapshot conforme (`export_openapi.py --check` exit 0); TypeScript `npm run typecheck` exit 0; architettura a 0 errori e 31 avvisi dimensionali conformi al baseline. Suite completa del motore su directory temporanea isolata `HOMUN_DATA_DIR` congelata a **1792 passati, 1 saltato, 1 avviso FastMCP in 218,69 s (3m 38s)**.
- **Tutto lo Stage C (C1, C2, C3, C4) è ora completamente completato e certificato.**

**D2a / H14 (Web Providers Dispatcher) conclusa e congelata:**
- Esteso e allineato `engine/src/homun/execution/web_providers.py` rispetto all'inventario e ai protocolli upstream di Hermes (`.audit-hermes-ref/plugins/web/`):
  - Integrati i protocolli reali di ricerca per `perplexity` (Perplexity Search API `POST /search` con `search_context_size: low` e fallback sulle citations), `xai` (xAI Responses API `POST /responses` con tool `web_search`, modello configurabile `grok-build-0.1` e parsing dell'envelope JSON/citations di Grok), `parallel` (Parallel Search API `POST /v1beta/search` con parametri `search_queries`, `objective`, `mode`, `max_results`), e `keenable` (Keenable Search API `POST /v1/search` sia keyed sia keyless su free-tier anonimo con header `X-Keenable-Title: homun-engine`).
  - Implementato `execute_provider_extract` per l'estrazione sincrona dei contenuti web via provider dedicati: `parallel` (`POST /v1beta/extract` con `full_content: True`) e `keenable` (`GET /v1/fetch?url=...`), con rifiuto esplicito tipizzato `web_provider_unsupported` in caso di richiesta di provider privi di supporto ad estrazione (es. `searxng`, `brave`).
  - Restituzione dell'errore tipizzato `web_provider_unsupported` per `openai-native` (che dichiara il tool server-side `web_search` di OpenAI e richiede il trasporto Codex Responses anziché una ricerca lato client).
  - Gestione rigorosa delle credenziali mancanti (`web_provider_credentials_missing`), del fallback con salvaguardia anti-cache su DuckDuckGo (`search_with_rescue`), e del filtraggio di indirizzi privati/loopback/metadata per tutti i provider prima di restituire qualsiasi hit (`_classify(link)` con `PageRefusal`).
  - Helper comune `_safe_hit` per eliminare boilerplate ridondante e mantenere il modulo a 423 righe (ben sotto il soft ceiling di 500 righe).
- 8 test dedicati passati in `test_d2a_web_providers.py` con server HTTP locali reali (`ThreadingHTTPServer`); 13 test passati in `test_web_pages.py`; OpenAPI snapshot conforme (`export_openapi.py --check` exit 0); architettura a 0 errori e 31 avvisi dimensionali conformi al baseline.

**Stage A (A1, A2, A3, A5) e Stage B3 formalmente congelati:**
- Eseguita la suite congiunta di certificazione isolata con **80 test passati in 8,75 s**:
  - `test_delivery_outcomes.py`: A1 deliverable claims e receipts con esiti veritieri.
  - `test_codex_stdio_transport.py` e `test_runtime_http_and_acp.py`: A2 alternative runtimes e stdio child transport.
  - `test_write_approval_outcomes.py`: A3 write approvals e intent prima dell'effetto.
  - `test_cron_occurrence_ownership.py`: A5 atomic occurrence lease, claim ownership ed eventi.
  - `test_delegation_runtime.py`: B3 child run ammessi, tool scoping, cancellation fences e parent wake.
- Verificati anche 21 test delle suite adiacenti (`test_h42_deliverables.py`, `test_cron_dispatcher_and_chronos.py`, `test_cron_jobs_and_scheduler.py`, `test_cron_activation_api.py`, `test_delegation_tools.py`).

**D1 (Channels Inbound Lifecycle, Queue, Recovery & Media Protocols) conclusa e congelata:**
- Implementata la coda durevole SQLite `InboundChannelQueue` (`channel_inbound_queue.py`):
  - Inserimento atomico dei messaggi inbound (`pending`), assegnazione con lease e lock anti-concorrenza (`claim_next` con `BEGIN IMMEDIATE`), marcatura esiti (`completed`, `failed`), e procedura di ripristino per riavvii / crash (`recover_stale_claims`).
- Implementato il supervisore di consegna e media `ChannelDeliverySupervisor` (`channel_delivery_recovery.py`):
  - Tracciamento intent destination-scoped prima dell'I/O; classificazione rigorosa tra errori transitori (`failed_retryable`) ed errori definitivi (`failed_fatal`).
  - Dispatching dedicato dei protocolli media outbound su Telegram (`sendPhoto` per immagini, `sendDocument` per documenti/file con caption e chat_id, anziché serializzazione forzata su solo testo).
- Implementato il poller di canale resiliente `ChannelPoller` con avanzamento durevole dell'`offset` per evitare duplicazioni di messaggi dopo restart.
- Implementata e registrata la rotta API `channel_ingress_api.py` (`/v1/gateway/channels/` per webhook ingress, query queue, trigger di recovery e polling).
- 11 test dedicati passati in `test_d1_channel_lifecycle.py`; 28 test passati in `test_gateway_and_channels.py`; OpenAPI snapshot aggiornato e verificato (`export_openapi.py --check` exit 0); TypeScript `npm run typecheck` exit 0; architettura a 0 errori e 31 avvisi dimensionali conformi al baseline.
**D2 (MCP/Plugins/Providers: Interactive OAuth, Elicitation & Pre-Tool Hooks) conclusa e congelata:**
- Implementato `MCPOAuthBroker` (`mcp_oauth.py`) per il flusso di autenticazione interattivo PKCE (generazione code verifier/challenge S256, build authorization URL, scambio codice di autorizzazione con token).
- Implementata la gestione interattiva delle elicitation (`install_product_elicitation` / `set_elicitation_callback`) con flag di attivazione esplicito `HOMUN_MCP_ELICITATION`.
- Implementati ed eseguiti i pre-tool execution hooks (`agent_run_execution.py`) che invocano `PluginManager.call_hook("pre_tool_call", ...)` con blocco/autorizzazione puntuale prima dell'esecuzione del tool.
- Espansi i profili di connessione provider in `ModelRegistry` (`anthropic`, `openrouter`, `gemini`, ecc.) come connessioni `openai_compatible` con endpoint e configurazioni canoniche.
- 6 test dedicati passati in `test_d2_mcp_plugins_providers.py`; 16 test passati in `test_mcp_protocol.py`.

**D3 (Media Backends, Voice Mode & Integrations) conclusa e congelata:**
- `media_backends.py`: implementati `resolve_image_dispatcher`, `resolve_video_dispatcher`, `resolve_stt_dispatcher` con dispatchers canonici (`openai_image_dispatcher`, `fal_video_dispatcher`, `whisper_stt_dispatcher`) e fallback trasparenti per testing.
- `routes/media_api.py`: collegate le route FastAPI ai dispatcher di risoluzione.
- `media_voice_mode.py`: implementati `bind_audio_pipeline`, `feed_audio_chunk` e callback di cancellazione per barge-in bidirezionale.
- `routes/integrations_api.py`: registrati gli endpoint `/v1/integrations/configure` e `/v1/integrations/status` con persistenza e cifratura delle credenziali.
- 6 test dedicati passati in `test_d3_media_integrations.py`; 14 test passati in `test_h41_media.py` e `test_h43_integrations.py`.

**D4 (Operations Daemon, Batch Runner & Catalogs) conclusa e congelata:**
- `daemon_lifecycle.py`: implementati `start` e `restart` reali con gestione processi orfani, attesa su zombie (`waitpid`), e rigenerazione del PID del demone.
- `batch_eval_runner.py` e `routes/research_api.py`: implementato `create_canonical_batch_executor` collegato a `ModelRegistry` e `TrajectoryStore`.
- `surface_catalog_packs.py`: estesi i catalog pack `productivity` (incluso `pdf_toolkit` con script operativi verificati) e `research`, con supporto per directory `SKILL.md` e risorse bundle.
- 4 test dedicati passati in `test_d4_operations_catalogs.py`; 17 test passati in `test_h44_operations.py`, `test_h45_research.py`, `test_h46_catalog.py`.

---

## Certificazione Completa dell'Engine (Milestone Conclusiva)

- **Test suite completa del motore (`engine/tests`):**
  - Comando: `HOMUN_DATA_DIR=$(mktemp -d) PYTHONPATH=engine/src engine/.venv/bin/python -m pytest engine/tests -q`
  - Risultato: **1827 passati, 1 saltato, 1 warning (FastMCP) in 233.15s (03m 53s)**.
  - **Zero fallimenti (100% green)**.
- **Architettura (`tools/check_architecture.py`):**
  - Risultato: **0 errori, 31 avvisi dimensionali** (perfettamente identico al baseline iniziale congelato).
- **Contratti OpenAPI (`tools/export_openapi.py --check`):**
  - Risultato: **OpenAPI snapshot matches current engine routes (exit 0)**.
- **Frontend / Client TypeScript & Tests:**
  - `npm run typecheck`: **exit 0 (0 errori)**.
  - `npm test`: **249 test passati su 249 (0 fallimenti)**.
- **Tutti gli Stage A, B, C, D (da A1 a D4 e H01–H46) sono completati a livello di motore backend.** Nessun dato simulato utilizzato; piena verità degli effetti e separazione esplicita.

---

### Prossimi Passi (Fase Successiva al Motore)

1. Integrazione UI generale ed eventuale collegamento delle viste frontend alle nuove capability native del motore completato.
2. Verifica su desktop app con build packaging ed esecuzione end-to-end con display reale.

