# Homun — specifica di passaggio e prosecuzione

**Destinatario:** un altro modello/agente di sviluppo che subentra senza conoscere la conversazione.
**Fotografia:** 19 settembre 2026, dopo la consegna del nuovo flusso conversazionale e la verifica nativa.
**Repository:** `/Users/fabio/Projects/Homun/homun2`.
**Branch verificato:** `fabio/production-foundations`.

Questo documento è autosufficiente per orientarsi, ma il codice e le prove correnti vanno verificati prima di modificarli. I risultati riportati sono quelli dell’ultima consegna: non sono test rieseguiti durante la scrittura di questo passaggio. Le priorità di prosecuzione sotto sono raccomandazioni operative, non nuove decisioni di prodotto già approvate nel dettaglio.

## 1. Mandato e obiettivo di prodotto

Fabio vuole costruire prima fondamenta solide, adatte alla produzione, senza monoliti e senza dover riscrivere tutto dopo una demo. Ha autorizzato la prosecuzione autonoma delle attività tecniche verificabili e, successivamente, anche l’uso della GUI sul Mac sbloccato. Il presente incarico prepara il passaggio; non crea una nuova esecuzione o un’automazione.

Homun deve permettere a un’azienda di lavorare con collaboratori umani e artificiali attraverso una conversazione naturale. La chat è la superficie principale. Progetti, compiti, materiali, squadra e viste operative devono rappresentare gli stessi oggetti persistiti, non costituire applicazioni separate.

Un lavoro conserva obiettivo, risultato atteso, vincoli, materiali, responsabile, revisore, piano, contributi mancanti e risultati. Gli agenti hanno identità e istruzioni persistenti, separate dal modello che li esegue. Memoria e apprendimento devono avere provenienza, ambito e possibilità di revisione. L’autonomia si concede per attività e contesto; approvare un risultato non autorizza automaticamente un invio o un altro effetto esterno.

**Non ridurre Homun a un comparatore di listini o a un coding agent.** Il confronto CSV è il primo caso reale e verificabile per esercitare le fondamenta. Una semplice domanda deve poter restare una domanda: l’attuale nuova conversazione tende a creare una bozza di lavoro, e questa distinzione resta da perfezionare.

## 2. Regole da preservare

Leggi anzitutto `AGENTS.md` nella radice e le eventuali istruzioni applicabili alle directory modificate.

- Nessun monolite nuovo. Moduli distinti per dominio, storage, policy, API, hook e pannelli. Non aumentare le eccezioni del controllo architetturale per far passare una modifica.
- Riutilizzare porte, helper, componenti e pipeline esistenti. Niente secondo orchestratore o implementazioni parallele della stessa decisione.
- Errori tipizzati e visibili (`HomunClientError`, `HomunErrorNotice`, errori di dominio). Mai simulazione come fallback silenzioso del motore.
- `Fonte: motore` e `Fonte: simulazione` restano esplicite. Non mostrare agenti, risultati o capacità dimostrative come reali.
- Il modello propone; il backend valida e applica le policy. Istruzioni del modello e nomi dei ruoli non concedono permessi.
- Prima interpretazione e proposta del collaboratore, poi conferma, poi eventuale azione concreta autorizzata. Nessuna assegnazione anticipata.
- Preservare richiesta originale e cronologia. Un titolo manuale non deve essere sovrascritto da una sintesi successiva.
- Fare incrementi piccoli con prova del comportamento, non solo del codice. La GUI nativa è un gate distinto da typecheck, test, build e smoke API.
- L’autonomia tecnica non autorizza messaggi esterni, spese, migrazione distruttiva dei dati reali, nuovi privilegi o pubblicazioni non richieste.

### Stato Git delicato

Il working tree contiene molta implementazione precedente modificata e non tracciata. Non è una checkout pulita e **HEAD da solo non rappresenta ciò che è stato consegnato**. Esegui `git status --short` prima di lavorare. Non usare reset, clean, stash indiscriminato o un nuovo worktree che perda queste modifiche. Prima di isolare una branch, definisci come preservare l’intera base necessaria.

Il repository è collegato a Lovable: non riscrivere la storia pubblicata (force push, amend/rebase/squash di commit già pubblicati). Nessun commit o push è stato effettuato nell’ultima tranche. Non aggiungere `Co-authored-by` ai commit.

## 3. Architettura adottata

| Confine | Proprietario / responsabilità |
| --- | --- |
| UI | React/TypeScript in `apps/web`, conversazione e pannelli |
| Desktop | Electron in `apps/desktop`; avvia e possiede il processo motore |
| Motore | Python in `engine/src/homun`, API indipendente dalla UI |
| Modelli | ModelRegistry/ModelPort e adattatori provider |
| Loop agentico | Pydantic AI, secondo l’ADR adottata; non significa che ogni lavoro abbia già un loop generale operativo |
| Durabilità | DBOS: attese, esecuzioni, ripresa; evitare un secondo scheduler concorrente |
| Dominio e sicurezza | Homun: comandi, revisioni, autorizzazioni, materiali, artifact, ricevute, budget |
| Persistenza locale | SQLite workspace, checkpoint DBOS, blob gestiti e ricevute |

La shell usa `homun://app`, sandbox, context isolation, Node disabilitato nel renderer e proxy API ristretto. Il token effimero rimane nel processo principale. Il launcher lega la sessione al principale locale `person_fabio`; non è un sistema di autenticazione multiutente pronto.

Pydantic AI + DBOS restano la scelta vigente. Non sostituirli con Hermes, LangGraph o un loop artigianale sulla base di una somiglianza superficiale.

## 4. Stato implementato e verificato

Le fondamenta includono comandi versionati con fingerprint e replay, persistenza transazionale, policy di accesso alle letture e alle mutazioni, outbox/ripresa DBOS, ingestione materiali, backup offline v2 e recupero di flussi interrotti. Esistono profili agenti, progetti/team, grant, contabilità UsageAttempt e memoria locale. La completezza di ciascuna area va letta nei documenti di consegna; presenza del modulo non equivale a tutte le funzionalità finali del prodotto.

### Nuovo flusso conversazionale

1. La richiesta crea una Conversation/Work bozza: titolo temporaneo `Nuova richiesta`, obiettivo `Obiettivo da concordare`, proprietario umano.
2. La richiesta originale viene persistita come messaggio.
3. Il modello configurato propone titolo breve, obiettivo, output, vincoli, informazioni mancanti, collaboratore reale oppure nuovo profilo, motivazione e capacità.
4. La proposta è persistita; non assegna e non esegue.
5. La conferma verifica digest, revisione del lavoro, autorità corrente, revisione dell’agente e che la proposta sia l’ultima. Creare un nuovo profilo richiede `create_agent: true` esplicito.
6. La conferma salva titolo/obiettivo e assegna il responsabile. Quando il proprietario umano confermante delega a un agente e non esiste un revisore, rimane revisore. Un revisore già presente non viene sostituito.
7. Per `compare_csv`, compaiono i materiali e l’approvazione dell’azione concreta. `general` indica preparazione del lavoro, non esecuzione generale automatica.
8. Il confronto deterministico esistente genera report e CSV, lasciando il lavoro in revisione umana.

Informazioni o file mancanti vengono mostrati ma non impediscono di confermare il collaboratore: bloccare l’affidamento in attesa dei file avrebbe impedito di raggiungere il caricamento. L’approvazione operativa resta separata. Un accordo può essere riformulato solo mentre il lavoro è una bozza senza piano o artifact.

Il backend blocca anche i comandi generici di piano/avvio/assegnazione che tentino di aggirare un intake non confermato. Le conversazioni legacy prive di intake mantengono il comportamento precedente e non vengono riassegnate automaticamente.

### UI consegnata

- Riepilogo destro compatto: titolo, stato italiano, obiettivo in lettura, responsabile reale e prossimo passo.
- Rinomina e modifica obiettivo esplicite; niente textarea permanente per leggere.
- Diagnostica motore e inventario lavori nei dettagli richiudibili.
- Squadra motore alimentata dal catalogo reale, senza Marta/Vera/Elio della simulazione.
- Scheda proposta in chat e upload CSV contestuale all’accordo.
- Verifica della finestra normale e ridotta, report apribile e scroll della chat indipendente dal riepilogo.

### Correzioni importanti da non perdere

- **Autorità dopo la delega:** senza conservare il revisore umano, l’approvazione CSV falliva appena il proprietario diventava un agente. Esiste ora un test completo staffing → approvazione → artifact.
- **Chiavi React distinte:** editor del titolo e dell’obiettivo avevano la stessa key fra fratelli; nel cambio lavoro poteva restare un vecchio obiettivo. Ora usano prefissi distinti.
- **Ciclo di refresh:** il recupero dell’intake azzerava `loaded` e smontava la scheda CSV; il rimontaggio dimenticava il completamento e ricaricava inventario/storico, ripetendo il ciclo. `useWorkIntake` aggiorna in posizione; in caso di lettura negata elimina comunque la proposta. Non reintrodurre un reset indiscriminato ad ogni variazione dei messaggi.

## 5. Mappa dei file da leggere

Percorsi relativi alla radice del repository.

| Area | File / directory |
| --- | --- |
| Sintesi strutturata | `engine/src/homun/models/intake.py` |
| Proposta e conferma | `engine/src/homun/application/intake.py`, `intake_policy.py` |
| Gate operativi intake | `engine/src/homun/policy/intake.py` |
| API intake | `engine/src/homun/routes/intake.py`, `contracts/openapi/v1-engine.json` |
| Rinomina | `engine/src/homun/domain/commands/naming.py` |
| Confronto e approvazione | `engine/src/homun/application/price_comparisons.py`, `price_comparison_policy.py`, `price_comparison_execution.py` |
| Policy condivise | `engine/src/homun/policy/` |
| Runtime e backup | `engine/src/homun/runtime/`, `storage/installation_backup.py`, `storage/backup.py` |
| Trasporto/creazione UI | `apps/web/src/lib/engine-intake-client.ts`, `engine-intake-creation.ts`, `engine-work-naming.ts` |
| Stato conversazione | `apps/web/src/hooks/useEngineWorkspace.ts`, `useEngineWorkspaceSnapshot.ts`, `useEngineTranscript.ts`, `useWorkIntake.ts` |
| Presentazione intake | `apps/web/src/components/builder/EngineWorkIntake.tsx`, `engine-work-intake.css` |
| Riepilogo | `EngineWorkspaceWorkPanel.tsx`, `EngineWorkObjectiveEditor.tsx`, `engine-work-summary.css` nella stessa directory |
| Confronto UI | `EnginePriceComparison.tsx`, `apps/web/src/hooks/usePriceComparison.ts` |
| Composizione UI | `ConversationWorkspaceChatStage.tsx`, `ConversationWorkspaceSidebar.tsx`, `ConversationWorkspaceSpaceHost.tsx` |
| Squadra reale | `EngineWorkspaceAgents.tsx` |
| Test principali | `engine/tests/test_intake.py`, `test_price_comparison_execution.py`, `tests/engine-intake-client.test.ts` |
| Packaging | `tools/build_engine_bundle.py`, `apps/desktop/scripts/package-app.mjs`, `engine/packaging/smoke.py` |

`ConversationWorkspace.tsx` era a 1.459 righe e `useEngineWorkspace.ts` a 461. Il controllo architetturale aveva zero errori e 29 avvisi legacy. Non interpretare ciò come eliminazione di tutti i file troppo grandi.

### Contratto intake da preservare

Prefisso: `/v1/workspaces/ws_local/works/{work_id}`.

- `POST /intake`: `command_id`, `text`, `expected_version`.
- `GET /intake`: `{items: [...]}`.
- `POST /intake/{proposal_id}/confirm`: `command_id`, `digest`, `expected_version`, `create_agent`.

Stati pubblici: `pending_confirmation`, `confirmed`, `failed`. Campi della proposta: `id`, `work_id`, `expected_version`, `digest`, `title`, `objective`, `output`, `constraints`, `missing_information`, `suggested_agent`, `new_agent`, `rationale`, `capability`, `original_request`, eventuale `error_code`.

Un errore del provider può essere rappresentato da una proposta `failed` persistita anche con HTTP 200: la UI deve controllare lo stato, non dedurre successo dal solo codice HTTP. Il segnaposto `intake_interrupted` viene recuperato con polling limitato. Verificare il sorgente per i dettagli prima di evolvere il contratto.

## 6. Evidenze e demo riproducibile

Ultima verifica completa consegnata:

- Motore: **372 passati, 1 saltato**, deprecazione Starlette/AnyIO nota.
- Frontend: **137 passati**, TypeScript e build web/prototipo riusciti; warning sui chunk grandi ancora presenti.
- Desktop con motore incorporato: **8 passati**.
- OpenAPI allineata, controllo architetturale senza errori, `git diff --check` pulito.
- GUI nativa con modello locale **Qwen3.5:4b**: proposta, creazione esplicita di un collaboratore, successivo riuso del catalogo, caricamento file, approvazione, report, riavvio e layout ridotto.
- Correzione del ciclo React verificata nella GUI e con i controlli frontend; manca un test automatico dedicato al ciclo mount/refresh.

### Build di riferimento

App relativa al repo:
`dist/desktop/2026-09-19T12-50-30-931Z/Homun-darwin-arm64/Homun.app`.

ZIP: `dist/desktop/2026-09-19T12-50-30-931Z/Homun-0.1.0-macos-arm64.zip`.
SHA-256: `fb4065f09e50ae7a84c6dad85e134e48ac1a34c10e3f5b90452b998284c10051`.

CRC ZIP, inventario motore estratto, corrispondenza della shell e smoke senza Python di sviluppo sono stati verificati. È un candidato locale macOS arm64 **non firmato Developer ID e non notarizzato**, non una release certificata. Il fatto che fosse aperto alla consegna non garantisce che lo sia ancora.

### Dati della prova

Materiali sintetici: `demo/price-comparison/README.md`, `listino-agosto.csv`, `listino-settembre.csv`, `expected-results.json`. Il JSON è un oracolo indipendente: non darlo al modello come risposta da copiare.

Risultati attesi: 4 aumenti, 3 diminuzioni, 2 invariati, 3 nuovi, 3 rimossi, 3 SKU esclusi; 4 segnalazioni di anomalia. Nessuna conversione valutaria, nessuna correzione automatica, percentuale non calcolabile quando la base è zero. I file hanno 16 e 15 righe dati.

Demo finale persistita nel profilo locale:

- Work `work_HBVRKmo8Kv3x9A`, titolo `Confronto listini cancelleria`.
- Owner `agent_6CJBvMqfk9oTsg`, nome `Analista Prezzi Cancelleria`; reviewer `person_fabio`.
- Confronto `e0533909-3c0d-458f-b75c-59a6d1855eee`.
- Artifact `art_aHJ0bX5jGZ3ZwA`, un tentativo, un solo risultato anche dopo riavvio.

La demo precedente è stata rinominata dalla GUI `Confronto listini · demo iniziale`, conservando messaggi e report. Esistono anche prove intermedie, inclusa quella con errore di approvazione prima della correzione: non cancellarle o modificarle per fingere una storia senza errori.

Profilo nativo: `~/Library/Application Support/Homun/engine`; workspace DB `ws_local.sqlite3`. Usare preferibilmente un profilo temporaneo per nuove prove. Non modificare il DB reale direttamente per far passare una demo, non leggere segreti e non migrare automaticamente il vecchio profilo Homun2.

## 7. Hermes e altri sistemi: ciò che abbiamo imparato

Fabio ha chiesto esplicitamente di studiare Hermes e altri sistemi open source. La ricerca è già presente:

- `docs/research/2026-09-19-hermes-homun-comparison.md`.
- `docs/research/2026-09-19-agent-systems-lessons.md`.
- `docs/research/2026-09-19-conversation-context-slice.md`.

Primo snapshot Hermes: `ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998`, clone `/Users/fabio/Projects/Homun/agent-system-research/hermes-agent-2026-09-19`.
Aggiornamento successivo: `236689b9b4ce70099da10a3fabf54bb96898cf45`, clone temporaneo `/tmp/homun-hermes-research-20260919` (potrebbe non esistere più).
Sono state consultate anche fonti primarie di LangGraph, Letta, OpenHands Software Agent SDK e Microsoft Agent Framework. Nessun benchmark o esecuzione di quei runtime è stato certificato.

Lezioni da mantenere:

1. Separare transcript persistito e contesto composto per una chiamata. Selezione, sintesi e pruning non devono riscrivere la storia.
2. Registro strumenti con schema, disponibilità, effetti, limiti e policy. Installazione, esistenza e autorizzazione sono concetti distinti.
3. Approvazioni legate ad azione, argomenti, fonti e revisioni; rivalidazione al momento dell’effetto.
4. Delega con contesto esplicito, accessi minimi e limiti aggregati del lavoro.
5. Memoria e procedure versionate con provenienza e revisione, non apprendimento implicito indiscriminato.
6. Un proprietario chiaro del recovery e prove del risultato concrete per il dominio aziendale.

Hermes non è solo coding, ma il suo modello personale single-tenant non sostituisce il contratto aziendale di Homun. Riprendere i meccanismi utili, non copiare il monolite o importare un nuovo orchestratore. Per affermazioni aggiornate sul progetto upstream, verificare nuovamente le fonti ufficiali; gli snapshot descritti sono storici.

## 8. Limiti aperti: non presentarli come risolti

- La sintesi del modello può cambiare l’enfasi del titolo/output quando l’utente sta solo correggendo il collaboratore. Il contesto precedente viene passato e la capacità CSV è stata preservata nelle prove successive, ma la qualità semantica non è garantita.
- La scelta del collaboratore usa il catalogo reale e le istruzioni; non equivale a un registro generale di competenze eseguibili e autorizzate.
- `compare_csv` è una capacità concreta; `general` resta pianificazione. Non promettere un agente operativo universale.
- Il fake provider non produce attualmente la sintesi strutturata valida dell’intake: fallisce in modo recuperabile. I test unitari usano output controllati; non confonderli con comprensione reale.
- Titoli legacy non sintetizzati automaticamente; uno è stato corretto esplicitamente. Nessuna migrazione globale approvata.
- Verificare la disponibilità UI di **Rivedi l’accordo** dopo che esiste un piano: la sola condizione `draft` è più larga del vincolo backend “draft senza piano/artifact”. Il backend rifiuta, ma il suggerimento UI potrebbe essere fuorviante.
- Verificare che modifiche manuali all’obiettivo e accordo confermato non lascino due riepiloghi presentati come entrambi correnti. Definire se la scheda è storica o aggiornata; non sincronizzare silenziosamente cambi semantici.
- Restano aree di simulazione e avvisi legacy di dimensione; effettuare audit per superficie, non sostituzioni indiscriminate.
- Budget aggregati con prenotazioni atomiche, registry tool generale, delega operativa e skill portabili sono incompleti.
- Cifratura operativa, Keychain/recupero chiavi, firma/notarizzazione, aggiornamenti/rollback e prova su Mac pulito restano gate di release.
- Identità e collaborazione multiutente esterne non sono implementate dal token locale. Compatibilità/rollback DBOS richiedono un contratto distinto dallo schema workspace.

## 9. Come continuare: ordine raccomandato

### Passo A — Ricognizione breve e fotografia attendibile

1. Leggere questo documento, `AGENTS.md`, l’ultima verifica intake e la specifica approvata.
2. Verificare branch, diff e file non tracciati. Non ripartire da zero o dal vecchio progetto `/Users/fabio/Projects/Homun/app`.
3. Confrontare sorgenti attuali con la build di riferimento. Rilevare eventuali modifiche di Fabio o di altri modelli intervenute nel frattempo.
4. Presentare un breve stato: cosa è confermato, cosa è cambiato, quale incremento si affronta. Non chiedere di nuovo il goal già spiegato.

**Uscita:** piano circoscritto con file interessati e prove di accettazione; niente refactor generalizzato.

### Passo B — Rendere affidabile l’accordo conversazionale

Prima priorità raccomandata: chiudere le ambiguità del brief e i difetti di lifecycle, perché condizionano tutta l’esperienza.

- Separare la modifica del responsabile da una variazione dell’obiettivo. Una frase come “usa un altro agente” non deve cambiare output, vincoli o capacità.
- Definire aggiornamenti strutturati e versionati del brief, con conservazione esplicita dei campi non modificati. Non risolvere con keyword hardcoded del caso cancelleria.
- Distinguere domanda, chiarimento e nuovo lavoro; evitare creazione di agenti/lavori per ogni saluto o domanda. Questa evoluzione richiede un piccolo design prima del codice.
- Rendere coerenti scheda accordo, riepilogo, modifiche manuali e stato di piano. Mostrare solo azioni applicabili.
- Aggiungere una prova automatica del ciclo di refresh: un risultato completato non deve causare refresh infiniti, perdere l’espansione del report o azzerare lo scroll; revoca e cambio lavoro devono eliminare dati non autorizzati.

**Accettazione:** suite di richieste e correzioni in italiano; test deterministici del contratto più prove separate con modello reale. Coprire cambio solo agente, cambio obiettivo esplicito, agente assente, file mancanti, provider offline, risposta invalida, proposta superata, rinomina manuale, ripresa e revoca. Nessun effetto o assegnazione prima della conferma.

### Passo C — Dal primo tool a capacità riutilizzabili

Dopo B, proporre una slice che estragga quanto già provato dal confronto CSV senza cambiare il suo comportamento.

- Registro unico di capacità/tool con input/output tipizzati, versione, effetti, prerequisiti, timeout e limiti.
- Disponibilità effettiva e autorizzazioni interrogabili dal backend per motivare la raccomandazione del collaboratore.
- Riutilizzare policy, digest, fonti immutabili, esecuzione DBOS e ricevute. Non creare una seconda pipeline CSV.
- Aggiungere prima un solo caso locale limitato, per esempio lettura autorizzata di un materiale e produzione di un artifact; niente accesso browser/filesystem indiscriminato.

**Accettazione:** tool assente/negato non viene proposto come eseguibile; cambi di fonti o argomenti invalidano approvazioni; retry/restart non duplicano effetti; output e contesto sono limitati. Conservare test e demo CSV.

### Passo D — Budget, contesto e memoria nel ciclo operativo

- Definire un budget persistito per lavoro che includa chiamate, retry e delegati; riserva atomica prima dell’azione e riconciliazione dopo. Usage sconosciuto resta sconosciuto, non zero.
- Estendere il contesto autorizzato con lavoro, materiali e memoria pertinente, mantenendo riferimenti/versioni/hash e limiti espliciti.
- Riutilizzare la slice di contesto esistente. Riesaminare accesso prima di pubblicare effetti; non promettere di ritirare dati già inviati a un provider.
- Solo dopo questi confini rendere operativa una delega più ampia attraverso il loop Pydantic AI e le attese DBOS.

**Accettazione:** concorrenza su budget, esaurimento, cancellazione, retry, revoca, restart e fonti di memoria tracciabili. Nessun nuovo framework senza motivazione e decisione esplicita.

### Passo E — Distribuzione e operatività

Preparare prove riproducibili su profili sintetici per Mac pulito, upgrade, restore completo e rollback. Definire cifratura di workspace, checkpoint, blob e ricevute, custodia e perdita chiavi. Firma e notarizzazione richiederanno identità/certificati appropriati: non inventarli né migrare segreti reali autonomamente.

Questo passo può avere analisi e test isolati in parallelo alle slice prodotto, ma non deve diventare un pretesto per dichiarare “production ready” il pacchetto locale già esistente.

## 10. Comandi e metodo di verifica

Dalla radice del repository, dopo aver letto script e configurazione correnti:

```sh
git status --short
git branch --show-current
npm run typecheck
npm test
npm run engine:test
npm run architecture:check
engine/.venv/bin/python tools/export_openapi.py --check
git diff --check
```

Per test focalizzati:

```sh
engine/.venv/bin/pytest -q engine/tests/test_intake.py engine/tests/test_price_comparison_execution.py
node --experimental-strip-types --test tests/engine-intake-client.test.ts
```

Per il pacchetto:

```sh
npm run desktop:build
HOMUN_TEST_ENGINE="$PWD/dist/engine/homun-engine" npm run desktop:test
```

`npm run desktop:build` ricostruisce motore e app. Se sono cambiati solo i sorgenti web, `npm run desktop:package` può riutilizzare il motore, ma soltanto se l’inventario è ancora valido. Il binario è `dist/engine/homun-engine`, **non** `dist/engine/homun-engine/homun-engine`.

`npm run check` include typecheck, test frontend e build web/prototipo. Non eseguire due build web concorrenti sullo stesso output. Conservare log separati per ogni tentativo; i vecchi log `/tmp` possono scomparire e non sono un artefatto durevole.

La verifica dell’archivio deve controllare checksum e CRC, estrarre in directory temporanea, verificare inventario e shell e avviare lo smoke sul binario estratto. Consultare i moduli di packaging e la consegna desktop; non certificare un nuovo ZIP riutilizzando l’hash del vecchio.

Per GUI usare gli strumenti di controllo disponibili nella nuova sessione, rispettandone le istruzioni. Nella sessione precedente è stato usato `mcp__cua_repl` con screenshot e albero accessibilità, non API nascoste o modifiche del DB al posto dei clic. Non assumere che finestre, indici AX, variabili della sessione o Mac sbloccato siano rimasti disponibili.

## 11. Documenti di riferimento e precedenza

Ordine utile di lettura:

1. `AGENTS.md` e `docs/STATO.md`.
2. `docs/research/2026-09-19-conversational-intake-ux-verification.md` — ultima prova e limiti.
3. `docs/superpowers/specs/2026-09-19-conversational-intake-ux-design.md` — direzione UX approvata.
4. `docs/superpowers/plans/2026-09-19-conversational-intake-ux.md` — piano della tranche appena conclusa.
5. `docs/research/2026-09-19-price-comparison-demo.md` e `demo/price-comparison/README.md`.
6. `docs/research/2026-09-19-autonomous-foundations-delivery.md` e `2026-09-19-conversation-context-slice.md`.
7. `docs/research/2026-09-19-desktop-reliability-delivery.md`, `2026-09-19-schema-compatibility.md`, `2026-09-19-crypto-spike.md`.
8. Confronto Hermes e lezioni open source elencati sopra.
9. `docs/specifications/README.md` e specifiche di prodotto per distinguere requisiti, proposte e decisioni ancora aperte.

**Documentazione riallineata:** `docs/STATO.md` è il riferimento corrente, raggiungibile da README, roadmap e indice documentale. I rapporti precedenti hanno una nota storica e mantengono i risultati originali; le sezioni di bootstrap sono esplicitamente datate. Non interpretare un limite storico come aperto oggi senza confrontarlo con lo stato corrente. Quando consegni una nuova slice, aggiorna `STATO.md`, roadmap e il riferimento al pacchetto, lasciando integre le prove delle esecuzioni precedenti.

## 12. Consegna attesa dal prossimo modello

Per ciascun incremento riportare:

- comportamento prima/dopo e perché serve al prodotto;
- moduli modificati e confini preservati;
- test realmente eseguiti, separando fake, modello reale, API, GUI e pacchetto;
- problemi rimasti e decisioni per cui serve Fabio;
- eventuale build esatta, hash e demo riproducibile;
- stato Git e integrazione effettuata, senza push o rilascio impliciti.

Non fermarti a proporre un piano quando hai già l’autorizzazione e le informazioni per completare la slice. Non allargare però una correzione locale a migrazioni, cambi infrastrutturali o nuove policy di prodotto senza chiarire il cambio di perimetro.

## Prompt pronto da usare nella nuova conversazione

> Riprendi lo sviluppo di Homun in `/Users/fabio/Projects/Homun/homun2`. Leggi `AGENTS.md` e `docs/handoff/2026-09-19-ripresa-sviluppo-homun.md`, poi verifica lo stato corrente del working tree senza scartare modifiche. Parti dalla ricognizione A e affronta la prima slice circoscritta della priorità B: accordo conversazionale stabile e coerenza fra richiesta, responsabile e risultato. Conserva la chat come superficie principale, delega supervisionata, distinzione motore/simulazione, Pydantic AI + DBOS e moduli piccoli. Procedi autonomamente con analisi, piano breve, implementazione e verifiche fino a un risultato concreto; usa la GUI se disponibile. Segnala differenze rispetto al documento e blocchi reali, senza chiedermi di ricostruire il contesto. Non pubblicare, non migrare dati reali e non riscrivere la storia Git.
