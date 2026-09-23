# Rianalisi di Homun 2 — 23 settembre 2026

Analisi di `main`, commit `e5155baf`, versione sorgente `0.2.1001`. Working tree inizialmente pulito. Questa consegna aggiunge soltanto il rapporto: nessuna correzione al prodotto, commit, aggiornamento o installazione.

**Valutazione.** Homun ha ora fondamenta concrete per il lavoro supervisionato: dominio persistente, piani e artifact revisionabili, esecuzione locale, modelli per collaboratore, routine, dichiarazioni MCP e distribuzione desktop. Il rischio principale è la crescita disomogenea: nuove capacità del motore convivono con superfici del prototipo e con percorsi di esecuzione che non condividono ancora tutte le garanzie. La prossima tranche dovrebbe consolidare questi confini prima di ampliare le funzionalità.

**Prove eseguite in questa analisi**

| Controllo | Esito attuale | Perimetro |
| --- | --- | --- |
| `npm run check` | Passato | TypeScript, 193 test frontend, build web e prototipo |
| `npm run engine:test` | 499 passati, 1 saltato | 91,39 s; un warning di deprecazione Starlette/AnyIO |
| `npm run desktop:test` | 8 passati | Processo motore, protocollo, startup e packaging; nessun test updater nella suite |
| `npm run architecture:check` | 0 errori, 35 avvisi dimensione | Verifica automatica dei confini; non certifica correttezza dei flussi |
| OpenAPI `--check` | Allineata | Snapshot attuale e route del motore |
| Inventory packaging | 1 passato | `engine/packaging/test_inventory.py` |
| `npm run lint` | Non concluso | Interrotto dopo circa 3 minuti senza risultato; non conteggiato come passato o fallito |
| Riproduzioni mirate | 4 difetti riprodotti | Recupero catena, budget assegnatario, riconciliazione routine, doppio dialogo updater |
| GUI installata | Osservata | Finestra reale e albero accessibilità; versione installata 0.2.1000, diversa dal sorgente |

Log e tre script Python riproducibili sono in `/tmp/homun-reanalysis-20260923/`. Usano directory temporanee, provider finto e scheduler simulato. Gli assert dei tre script confermano il difetto: il loro exit 0 **non** significa che il comportamento del prodotto sia corretto. Vedere il README nella stessa directory.

La build emette avvisi sui chunk oltre 500 kB. Il lint globale include una configurazione di esclusione poco specifica per la nuova struttura (`eslint.config.js`): va delimitato ai sorgenti utili e reso un controllo ripetibile. Non è stata diagnosticata qui la causa completa della sua durata.

**Problemi da correggere, ordinati per impatto**

1. **P1 — Materiali e Plugin della barra laterale usano ancora lo stato del prototipo in modalità motore.**

   In `apps/web/src/components/builder/ConversationWorkspaceSpaceHost.tsx:187` il ramo Materiali non distingue `engineMode`: usa `ConversationMaterials`, `setMaterials` e `setWorks`. La libreria è costruita da materiali e lavori del prototipo in `ConversationWorkspace.tsx:919`. Caricare o collegare da questa schermata non registra il materiale nel motore, mentre i tool lavorano sull'archivio del motore. Si possono quindi vedere file nella UI che il lavoro reale non può usare, e non vedere qui file già ingeriti nel motore.

   Il ramo Plugin (`ConversationWorkspaceSpaceHost.tsx:270`) usa `ConversationPlugins` e `setSpaceData`; aggiunta e assegnazione sono modifiche allo snapshot locale, separate dai server MCP reali delle impostazioni. È una violazione pratica della separazione esplicita simulazione/motore. Evidenza: tracciamento completo delle props e dei callback nel sorgente; non eseguiti upload sul profilo personale.

   Correzione proposta: collegare queste superfici ai client del motore o renderne esplicito e non ambiguo il carattere dimostrativo. Riutilizzare gli stessi cataloghi, riferimenti e operazioni già disponibili nelle impostazioni e nei tool.

2. **P1 — Una catena può fallire al recupero dopo avere completato correttamente il primo passo.**

   `engine/src/homun/runtime/workflows/tool_chain.py:52` salta i passi già completati, prima di eseguire la continuazione di riga 66. Se il processo si interrompe dopo la pubblicazione dell'artifact ma prima della continuazione, il lavoro rimane in revisione e le versioni dei passi successivi non vengono riallineate.

   Riproduzione: due letture approvate, prima eseguita, poi ripresa del core della catena. Risultato: `failed`, primo passo `completed`, secondo `blocked/version_conflict`, un artifact conservato. È una simulazione deterministica del confine di interruzione, non un kill/restart di DBOS dal vivo.

   Correzione proposta: rendere idempotente e recuperabile anche la continuazione fra passi; aggiungere un test sul punto fra pubblicazione e transizione.

3. **P2 — La sintesi non rispetta il sotto-budget del collaboratore assegnato.**

   `engine/src/homun/application/synthesis_execution.py:154` prenota contro `_actor`, cioè la persona che approva, anche se il modello esegue per il collaboratore letto a riga 136. Con allocazione del collaboratore già esaurita (`1` tentativo consentito e `1` speso), la sintesi termina comunque e il contatore del collaboratore resta `1`.

   Riprodotto con fixture reale del dominio e provider finto. Il budget complessivo del lavoro continua a essere coinvolto: il difetto riguarda l'allocazione individuale, non l'assenza totale di contabilizzazione. È distinto dal limite già documentato sulle stime preventive dei token.

   Correzione proposta: distinguere l'identità che autorizza da quella cui attribuire il consumo; verificare entrambi i limiti senza aggirare la policy di approvazione umana.

4. **P2 — La riconciliazione delle routine non ripara una cadenza rimasta indietro.**

   `engine/src/homun/application/routines.py:131` salva prima il dominio; soltanto a righe 143–144 aggiorna lo schedule DBOS. La riconciliazione a riga 181 controlla esistenza e stato, ma non cron e fuso orario. Un'interruzione o errore dopo il commit e prima della cancellazione dello schedule lascia la vecchia cadenza attiva anche dopo il recupero.

   Riproduzione con API DBOS simulate: dominio `12:00 Europe/Rome`, schedule esistente `08:00 UTC`; nessuna riparazione, creazione o cancellazione. Correzione proposta: confrontare la definizione completa dello schedule, oltre a pausa/attivazione.

5. **P2 — Cambiare la scadenza da Compiti non modifica il lavoro del motore.**

   `apps/web/src/components/builder/ConversationWorkspaceSpaceHost.tsx:168` invia la modifica a `setWorks`, lo stato del prototipo, mentre gli elementi mostrati provengono da `engine.works`. Il campo è quindi operativo solo nel percorso simulato. Il pannello della conversazione dispone invece di `engine.setDue` e del comando `work.set_due`.

   Evidenza statica del collegamento input→callback→stato; nessuna modifica alle scadenze dell'utente. Correzione proposta: usare la stessa operazione versionata in entrambe le viste e mostrare l'eventuale errore tipizzato.

6. **P2 — Il controllo aggiornamenti manuale propone due volte lo stesso aggiornamento.**

   `apps/desktop/src/updater.cjs:78` registra `offerUpdate` sull'evento `update-available`. `checkNow()` richiama la stessa funzione a riga 132 dopo `checkForUpdates()`, che già emette quell'evento (verificato anche nel sorgente locale della dipendenza).

   Riprodotto caricando il modulo in una VM Node con Electron simulato: un controllo manuale produce due dialoghi «Nuova versione di Homun». Scegliendo «Più tardi» il secondo ripropone subito la scelta; scegliendo download può comparire l'avviso di download già in corso. Nessun aggiornamento reale scaricato/installato.

   Correzione proposta: un solo proprietario del dialogo, con test specifici per controllo automatico, manuale e download in corso.

**Altri punti da chiarire e verificare**

- **Sintesi e vincoli sulle fonti.** `synthesis.py:37` verifica accesso ai materiali, ma non uguaglianza tra versione/hash correnti e binding approvato; `_materials_block` usa la fonte attuale scartando il binding restituito da `verify_material`. Le procedure selezionate vengono controllate per revisione all'approvazione, ma non nuovamente in `_skills_block` all'esecuzione. La revisione indipendente ha verificato una modifica lecita del titolo del materiale da v1 a v2 dopo approvazione, consumata dalla sintesi. Non è stata dimostrata una sostituzione dei byte del contenuto. Aggiungere prove sui cambi di fonti fra proposta, approvazione, esecuzione e pubblicazione.
- **MCP ha un contratto di recupero differente.** `application/external_tools.py` esegue sincronicamente dopo l'approvazione, fuori dalla transazione, e poi pubblica l'artifact. Non segue il percorso DBOS/outbox dei tool locali. Un esito esterno e la sua registrazione locale devono poter essere distinti; non attribuire a questo percorso le stesse garanzie di recupero senza prove dedicate.
- **Contraddizione visibile nelle impostazioni.** `ConversationCapabilitiesSettingsSection.tsx:64` dice «Plugin esterni e MCP non ancora disponibili» sotto il componente che permette già di dichiarare e provare server MCP.
- **Documentazione corrente non consolidata.** `docs/STATO.md` dice ancora che piano multi-fase, budget UI e catene sono da fare, poi li dichiara implementati nella sezione finale. Anche i conteggi di riferimento e le note desktop precedono gli ultimi sviluppi. Conservare le prove storiche, ma separarle nettamente dalla mappa corrente e dai prossimi passi.
- **Identità locale ancora specifica del profilo.** La pulizia del primo avvio migliora le etichette, ma il client conserva identificatori locali come `person_fabio` e la shell associa la sessione al launcher. Non equivale a provisioning multiutente o collaborazione fra installazioni.

**Architettura e prodotto**

| Area | Valutazione sul codice attuale |
| --- | --- |
| Dominio e persistenza | Separazione sostanziale fra comandi, policy, storage, API e runtime; comandi versionati e artifact sono una base da mantenere |
| Esecuzione | Confronto CSV, lettura e sintesi sono capacità concrete; `general` resta preparazione; le catene lettura/confronto hanno un confine di recupero da correggere |
| Supervisione | Proposta, approvazione e revisione restano esplicite; serve uniformità dei vincoli anche per sintesi e MCP |
| Routine | Creano lavori supervisionati secondo una ricorrenza; non dimostrano esecuzione autonoma completa del lavoro |
| Frontend | Chat, riepilogo, team, documenti e impostazioni hanno collegamenti reali; alcuni ingressi laterali mantengono una seconda fonte di stato |
| Modularità | Motore ben suddiviso; `ConversationWorkspace.tsx` è a 1425 righe, vicino alla soglia indicata da AGENTS; 35 avvisi includono anche copie legacy/prototipo |
| Distribuzione | Pipeline, firma e updater sono presenti nel sorgente; firma, notarizzazione, installazione su Mac pulito e aggiornamento completo non riverificati in questa analisi |

La finestra installata osservata conserva il modello chat centrale + riepilogo laterale e rende visibili contributi mancanti, scadenza e budget. È una prova della schermata corrente sulla 0.2.1000, non accettazione end-to-end della 0.2.1001. I tentativi di navigazione sono stati fermati dallo strumento perché rilevava una variazione della superficie: non sono stati forzati. Non sono stati inviati messaggi a modelli reali né alterati lavori del profilo personale.

**Ordine suggerito per una tranche di consolidamento**

1. Correggere recupero delle catene, attribuzione budget e riconciliazione cron con le riproduzioni come regressioni; verificare nello stesso passaggio i binding della sintesi.
2. Allineare Materiali, Plugin e scadenze alle operazioni del motore; verificare che due schermate della stessa entità mostrino e modifichino lo stesso stato.
3. Correggere e coprire l'updater, poi provare un aggiornamento completo fra due build su profilo temporaneo.
4. Consolidare stato e roadmap, aggiungere poche prove di integrazione sui collegamenti React e sui punti di interruzione del runtime. Il numero di unit test, pur positivo, non copre questi confini da solo.

Non propongo una riscrittura: i confini già presenti permettono interventi piccoli e verificabili. L'obiettivo della tranche è che ogni azione visibile abbia lo stesso significato, la stessa persistenza e gli stessi limiti indipendentemente dal punto di ingresso.
