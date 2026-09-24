# Stato verificato di Homun 2

Aggiornato il 24 settembre 2026: correzione dei falsi successi di parità Hermes
(H16/H33/H35/H39/H41/H43/H45) e backend terminale Docker del nucleo nativo.
Lo stato precedente e i rapporti datati conservano le prove storiche.
Una verifica del sorgente non aggiorna l'app installata.

Passaggio operativo corrente: [continuare la parità completa con Hermes](handoff/2026-09-24-parita-hermes-continuazione.md).
Include checkpoint, limiti, intero obiettivo e prompt per una nuova chat.

## Capacità presenti

- Backend Docker proprio con immagine fissata, directory dedicata, limiti risorse,
  log limitati e intenti persistenti che impediscono di ripetere un comando.
  Verificato su Docker reale e riapertura SQLite. Proposte e approvazioni esatte
  disponibili via API autenticate, con stato/log/arresto e ripresa senza redispatch.
  Collegamento nativo al modello con consenso per comando e receipt singola,
  configurazione opzionale e pannello UI presenti. Prova reale Ollama/Docker;
  durata approvata e watchdog persistente presenti mentre il motore è acceso.
  File del workspace elencabili, ricercabili e leggibili per righe; le modifiche
  attendono un'approvazione esatta e non usano uno snapshot obsoleto. Consegne
  immutabili scaricabili nel dettaglio lavoro. Verifica Ollama della patch e
  consegna, senza container. Language server e patch multi-file ancora aperti.
  [File e limiti](research/2026-09-24-workspace-files-verifica.md).
  [Modifiche](research/2026-09-24-workspace-edits-verifica.md).
  Sessione interattiva UI e timer indipendente ancora aperti. Le sessioni nuove
  possono avere un terminale che risponde a stato, cursore e dimensione; non è uno schermo completo.
  In alternativa, un comando può girare su questo computer, senza container e senza ereditare l'ambiente.
  [Scadenze](research/2026-09-24-terminal-deadline-verifica.md).
  [Ciclo agente](research/2026-09-24-agent-terminal-verifica.md).
  [Backend](research/2026-09-24-owned-terminal-verifica.md) e
  [consenso applicativo](research/2026-09-24-terminal-approval-verifica.md).

- Motore Python persistente con comandi versionati, autorizzazioni, materiali,
  artifact, piani, budget, outbox e workflow DBOS.
- Chat supervisionata: domanda oppure proposta di lavoro, accordo confermato,
  Homun diretto o collaboratore scelto, piano per fasi, approvazione degli effetti e revisione
  umana dei risultati. `general` indica preparazione, non esecuzione generica.
- Confronto CSV deterministico, lettura materiali e sintesi con il modello del
  collaboratore. Le fonti della sintesi vengono rivalidate all'approvazione,
  all'esecuzione e prima della pubblicazione.
- Materiali e Plugin dalla barra laterale usano ora le stesse API e gli stessi
  riferimenti delle impostazioni e degli strumenti. La libreria materiali offre
  ricerca, filtro progetto, upload file/cartella, lettura e archiviazione.
  Errori di accesso non conservano l'anteprima precedentemente aperta.
- Gestione collaboratori, team, progetti, piani, scadenze e budget nel percorso
  motore. Compiti modifica la scadenza persistente anche dal proprio dettaglio.
- Documenti approvati consultabili; routine cron che creano lavori supervisionati.
  La riconciliazione ripara anche divergenze di cron e fuso, conservando la pausa.
- Budget globale e allocazioni per collaboratore: la sintesi contabilizza
  l'assegnatario, mantenendo la persona come autorità dell'approvazione. Consumi
  parziali conservano i token noti e registrano il tentativo come incerto.
- Server MCP dichiarabili e strumenti ammessi esplicitamente. Shell Electron,
  pipeline di release e updater presenti; il controllo manuale offre un solo
  dialogo per l'evento di aggiornamento.

- Uso diretto senza creazione obbligatoria di bot; `agent_run` esegue un ciclo
  adattivo su materiali autorizzati, con osservazioni persistite e chiarimenti.
- Onboarding aziendale opzionale, proposta di squadra confermata, contesto usato
  nelle richieste successive e consultazioni dei collaboratori nel lavoro.
- Destinatari nominativi e portale temporaneo per contributi testuali; una risposta
  può far riprendere il ciclo adattivo. Identità dichiarata, non account verificato.

- Nuovi run OpenAI-compatible con messaggi e strumenti nativi, cronologia canonica
  e ripresa delle chiamate pendenti dopo un contributo umano. Nucleo mantenuto in
  Homun, derivato dalla logica Hermes con attribuzione MIT; nessun runtime esterno.

- Delegazione a sotto-agenti isolati (`delegate_task`, H21/H22) con budget limitato,
  istruzioni e strumenti dedicati, e validazione di output JSON Schema con riparazione
  delle code fences e conservazione del lavoro grezzo; polling e annullamento durevoli
  (`delegation_poll`, `delegation_cancel`) con stato salvato nel record del run.

- Chiarimenti umani strutturati (`clarify`, H08) con supporto a domande singole o
  in batch (fino a 5), opzione raccomandata contrassegnata ed esclusa dalla risposta,
  parsing selezioni multiple, conservazione delle risposte parziali in caso di timeout
  ed evidenza esplicita degli errori di recapito.

- Checkpoint del filesystem e rollback selettivo (`CheckpointManager`, H12) con
  store git shadow trasparente, ledger delle scritture dell'agente che tutela le
  modifiche manuali dell'utente, rollback selettivo per singolo file, raccolta diff
  dell'albero di lavoro (`collect_working_diff`) e isolamento dei sotto-agenti in
  worktree git dedicati (`create_subagent_worktree`, `cleanup_subagent_worktree`).

- Obiettivi persistenti su più turni (`GoalManager`, H25) con contratti strutturati
  (outcome, verification, constraints, boundaries, stop_when), criteri di qualità deterministici
  (`run_gate`), barriere di attesa su PID/sessioni/tempo (`wait_on`), giudizio di avanzamento
  fail-open e tetto sui turni senza creazione implicita di schede Kanban.

- Heartbeat di sessione inattiva (`HeartbeatManager`, H26) con claim immediato e ripristino/rewind
  in caso di cancellazione prima dell'esecuzione, coalescenza dei tick saltati, priorità assoluta
  dei messaggi umani e isolamento dei confini di conversazione su rotazione e reset.

- Loop proattivi a intervalli fissi o auto-adattivi (`LoopManager`, H27) con backoff esponenziale
  su digest normalizzati, marcatore di arresto autonomo (`LOOP_COMPLETE`), giudizio di arresto
  basato su evidenze (`--until`), tetto ai cicli (`--times`), pausa su budget tick e precedenza
  degli obiettivi (un obiettivo attivo differisce il loop, un obiettivo in attesa lo consente).

- Domande secondarie staccate contestuali (`SideQuestionRunner`, `/btw`, H03) su snapshot
  della cronologia senza turni sintetici o violazioni di alternanza ruoli, con soppressione
  degli strumenti e attribuzione di costi e token al run principale.

- Assemblaggio istruzioni e riferimenti al contesto (`PromptAssembler`, H04) con precedenza
  gerarchica documentata (`AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`),
  scansione minacce da prompt-injection, blocco file non attendibili e risoluzione riferimenti
  `@file` (con intervalli di righe), `@folder`, `@diff`, `@staged`, `@git`, `@url` con
  protezione SSRF su IP privati e blocco file sensibili.

- Chiamata programmatica di strumenti via esecuzione codice Python (`execute_code`, PTC, H13)
  su interprete figlio isolato con bridge RPC locale autenticato (UDS/TCP loopback), allowlist
  degli strumenti ammessi, tetto alle chiamate, troncamento output (40% testa / 60% coda) e timeout.

- Controllo nativo del computer e strumenti desktop/anteprima (`ComputerUseDriver`, `DesktopUiManager`, H16)
  con verifica dello stato di readiness del sistema operativo e permessi TCC (accessibilità e
  registrazione schermo), elenco finestre con z-order e messa a fuoco delle app, cattura schermo/finestra
  con gerarchia visiva SOM/vision/AX, blocco preventivo di combinazioni distruttive di tasti e pattern di
  shell injection, ispezione della finestra sottostante, estrazione del buffer del terminale xterm interno,
  gestione del riquadro di anteprima web/file, navigazione interattiva (click, type, scroll, elements)
  con aggiornamenti delta e annotazioni permanenti sugli elementi; esposto via endpoint REST `/v1/desktop`.

- Gateway multi-superficie e sincronizzazione cross-client (`SurfaceGatewayManager`, H34)
  con supporto unificato per client CLI, TUI, Desktop, Web/Dashboard e BotScreen, molteplici
  trasporti di connessione (locale, SSH, URL, cloud), isolamento per profilo, code di guida
  e steering interattivo coerenti (`drain_steering_guidance`), coda centralizzata delle richieste
  di approvazione (`request_approval`, `resolve_approval` con decisioni una-volta/sessione/sempre/nega),
  registro degli artifact e snapshot di stato condivisi in tempo reale; esposto via endpoint REST `/v1/surfaces`.



- Orchestrazione compiti con Kanban durevole e contratti PR (`KanbanStore`, `KanbanWorkflow`, H23)
  con persistenza SQLite WAL, isolamento dei profili, tracciamento DAG delle dipendenze,
  assegnazione worker con lease temporizzati e rinnovo heartbeat, recupero automatico
  dei worker arrestati o crashati, sblocco automatico delle dipendenze al completamento
  di una scheda, flusso di revisione strutturato (`request_review`, `review_card` con ciclo
  approve / changes_requested), contratti PR con verifica automatica dei criteri di gating
  e protezione branch prima del merge; esposto via endpoint REST `/v1/kanban`.

- Orchestrazione Mixture of Agents (`MoACoordinator`, H24) con modelli di riferimento
  consultivi (`MoAReferenceModel`) che consigliano senza schemi strumenti (gli advisor
  non causano effetti collaterali), aggregatore attivo (`MoAAggregator`) che esegue gli
  strumenti e sintetizza la risposta, cadenze fanout (`user_turn`, `per_iteration`,
  `every_n:N`) con riuso della guida in cache, filtri privacy (`display`, `full`) per
  l'oscuramento di credenziali/email/telefoni, unione reattiva dei turni utente adiacenti
  per backend con alternanza stretta e contabilizzazione veritiera e aggregata di token e costi.

- Protocolli e server OpenAI/ACP/MCP (H35) con endpoint compatibili OpenAI (`/v1/chat/completions`,
  `/v1/models`) che supportano streaming SSE con token e chiamate strumenti, caching per idempotenza
  tramite intestazione `Idempotency-Key` o digest del corpo, server agente MCP ospitato
  (`HostedMcpAgentServer`) con strumenti `homun_task`, `homun_ask`, `homun_status` via JSON-RPC/stdio,
  e adattatore IDE Agent Client Protocol (`AcpServerAdapter`) con gestione del ciclo di vita e
  consenso/rifiuto interattivo delle modifiche ai file.

- Sistema di estensione e plugin (H37) con caricamento di manifest v1/v2 (YAML/JSON),
  isolamento e gestione sicura dei moduli fratelli, ledger rigoroso delle registrazioni
  (strumenti, hook, provider, piattaforme, comandi, skill, pannelli UI e requisiti di segreti),
  dispatch di hook con ispezione delle signature e fail-closed sui blocchi di policy (`pre_tool_call`),
  ciclo di vita enable/disable privo di capacità residue (nessuno stale tool/hook o comando),
  ricaricamento dinamico della configurazione e contratto di conservazione dei dati persistenti
  (`<homun_home>/plugin-data/<name>/`) separato dall'albero di installazione del plugin.

- Registro provider di inferenza e routing ausiliario (H38) con profili dichiarativi per i principali
  provider (OpenAI, Anthropic, OpenRouter, DeepSeek, Gemini, Ollama, Custom), risoluzione euristica
  del provider dal modello, adattamento della sintassi di reasoning/thinking (`top-level reasoning_effort`,
  `extra_body.reasoning`, `anthropic_thinking`, nessuno per modelli che non supportano reasoning),
  adattamento dei fixture multimediali e dei risultati strumenti contenenti media (con fallback
  testuale informativo per provider non-vision), adattamento degli schemi di risposta, pool di
  credenziali multiple per provider con rotazione round-robin, gestione degli stati ok/cooldown/dead,
  finestre temporali di cooldown su errori 429/quota, e router ausiliario con catene di fallback
  prioritizzate e audit trail completo di tutti i tentativi di failover.



- Controlli nativi di pausa/ripresa/annullamento e correzioni dalla chat, con
  invalidazione delle risposte superate, conservazione degli esiti incerti e
  oscuramento delle fonti revocate. [Prove e limiti](research/2026-09-23-agent-controls-verifica.md).

- Checkpoint automatici del contesto senza cancellare la cronologia canonica,
  limiti del modello espliciti e consumo del riepilogo separato dalla decisione.
  [Prova Ollama e limiti](research/2026-09-23-agent-context-verifica.md).

- Recupero durevole dai guasti del provider (H06, prima tranche): errori nativi
  tipizzati e sanitizzati, consumi estratti prima della validazione, tre
  tentativi persistenti per fase con backoff base2+jitter o Retry-After (tetto
  600 s), attese senza lease visibili in API, strumenti committati mai ripetuti. Contatori salvati prima dell'IO,
  steering che interrompe le attese e stato di ritentativo nel pannello lavoro.
  [Prove reali Ollama e limiti](research/2026-09-23-agent-recovery-verifica.md).

- Recupero da contesto eccessivo con compattazione forzata persistente e limitata,
  senza aumentare l'output o ripetere richieste identiche.
  [Prova ibrida e limiti](research/2026-09-23-agent-overflow-verifica.md).

- Registro strumenti condiviso da modello, ricerca, validazione e dispatch;
  manifest fissato all’approvazione. Trasporto MCP con handshake, sessioni,
  descrittori e risposte strutturate. Il collegamento MCP al ciclo adattivo resta
  aperto. [Prove e limiti](research/2026-09-23-agent-registry-verifica.md).

- Chiamate MCP supervisionate con intento e ricevuta durevoli: ripresa della
  pubblicazione senza nuova chiamata, esiti incerti visibili, approvazione legata
  alla configurazione server e al lavoro. [Prove e limiti](research/2026-09-23-external-receipts-verifica.md).

- Riapprovazione della sola consegna per ricevute MCP salvate su lavori poi
  modificati: anteprima, consenso sulla versione corrente e artifact atomico,
  senza ripetere l’azione esterna. [Verifica](research/2026-09-23-external-delivery-verifica.md).

- Proposte MCP legate al descrittore reale e argomenti validati con JSON Schema
  locale. Prima della chiamata, discovery e confronto nella stessa sessione:
  contratti cambiati bloccano senza inviare l’azione. [Prove](research/2026-09-23-mcp-contracts-verifica.md).

- Strumenti MCP selezionati ora disponibili al modello nel ciclo nativo: ogni
  azione attende consenso, la ricevuta riprende il run e solo il risultato finale
  diventa artifact. Annullamenti e riavvii conservano gli esiti senza ridispatch.
  [Prova Ollama + stdio](research/2026-09-23-agent-mcp-verifica.md).

## Evidenze della tranche corrente

Recupero promesse finali: **885 test engine passati, 1 saltato**, più 64 controlli
finali. Ollama ha prodotto la nota dopo un invito automatico, senza ripetere
MCP. Recupero limitato e persistente; non è verifica semantica del completamento.
[Prove e limiti](research/2026-09-23-agent-liveness-verifica.md).

Continuazione testuale: **870 test engine passati, 1 saltato**, più 63 controlli
finali. Frammenti persistenti, consegna ricomposta una volta, controlli e budget
rispettati. Troncamento HTTP iniettato → riavvio SQLite → seguito Ollama reale.
[Prove e limiti](research/2026-09-23-agent-continuation-verifica.md).

Guardia ripetizioni: **843 test engine passati, 1 saltato**, più 46 controlli
finali. Errore tipizzato senza artifact o retry; consumi reali conservati.
Verifica HTTP iniettata e risposta normale Ollama reale; streaming ancora aperto.
[Prove e limiti](research/2026-09-23-agent-repetition-verifica.md).

Bridge MCP differito: **828 test engine passati, 1 saltato**, più 58 controlli
finali; architettura senza errori e OpenAPI invariato. Ollama/stdio reali:
ricerca → descrizione → chiamata approvata → ripresa dopo riavvio. Dati corretti,
formulazione finale ancora da migliorare. H07 resta parziale.
[Prove e limiti](research/2026-09-23-agent-bridge-verifica.md).

Risultati voluminosi: **805 test engine passati, 1 saltato**, più 7 controlli
finali; test web, typecheck/build e OpenAPI allineati, architettura 0 errori.
Ollama + stdio reali: risultato integrale salvato, ripresa da SQLite, ricerca
del dato centrale e una sola chiamata esterna.
[Prove e limiti](research/2026-09-23-agent-results-verifica.md).

Contratti MCP: **791 test engine passati, 1 saltato**, 216 test web; typecheck,
build e OpenAPI allineati, architettura 0 errori. Fixture stdio: contratto valido
una chiamata; descrizione mutata zero chiamate. Timeout prima/dopo invio distinti.

Consegna riapprovata: **777 test engine passati, 1 saltato**, più 19 verifiche
mirate con riapertura SQLite, lavoro cambiato e server rimosso. 216 test web,
typecheck/build e OpenAPI allineati; architettura senza errori.

Ricevute esterne: **768 test engine passati, 1 saltato**, poi **47 test mirati**
dopo la correzione finale; 216 test web, typecheck e build riusciti. Una vera
chiamata stdio resta singola dopo ricreazione del contesto e ripresa pubblicazione.

Registro e MCP: **759 test engine passati, 1 saltato**, **216 test web passati**,
typecheck e OpenAPI allineati, architettura 0 errori. Prova Ollama reale
ricerca → lettura → artifact riuscita. H07/H36 restano parziali.

Overflow: **729 test engine passati, 1 saltato**, OpenAPI allineato, architettura
0 errori. Fixture con HTTP400 iniettato e riepilogo/finale Ollama reali riuscita:
contesto stimato 10780 → 5182, sei righe corrette e cronologia conservata.

Recupero provider: **718 test engine passati, 1 saltato**, più 62 verifiche
mirate dopo l'ultima correzione della migrazione; typecheck e OpenAPI
allineati (campo opzionale `recovery`), architettura 0 errori. Prova reale:
rifiuto di connessione autentico convertito in attesa persistente poi riuscita
su Ollama `qwen3.5:4b` con budget onesto; 404 reale classificato fallimento
permanente tipizzato. Refresh credenziali, fallback, continuazione dei
troncamenti restano aperti; il recupero da overflow è ora parziale e limitato.

Contesto: 688 test engine passati, 1 saltato; typecheck e OpenAPI allineati.
Prova Ollama di compattazione riuscita, con sei righe corrette nell'artifact in
revisione e cronologia originale conservata. [Rapporto](research/2026-09-23-agent-context-verifica.md).

Controlli: 640 test engine passati e 1 saltato nella suite completa; ulteriori 32
controlli mirati includono la migrazione delle invocazioni DBOS precedenti.
Prova Ollama su due fonti con pausa/correzione/ripresa riuscita. Il percorso verso
la [parità Hermes](research/2026-09-23-hermes-parity-matrix.md) resta aperto.


Il [primo nucleo nativo](research/2026-09-23-owned-core-verifica.md) aggiunge
verifiche di trasporto, ripresa, autorità e una prova Ollama reale. Suite completa
finale: 625 test motore passati, 1 saltato, inclusi 17 test nativi.
OpenAPI invariato; wheel con attribuzione verificata.
L'app installata non è stata aggiornata.


Il [rapporto operativo](research/2026-09-23-homun-operativo-verifica.md) distingue
prove automatiche, modello locale reale e limiti. Suite: 608 motore passati e 1
saltato, 211 web, 11 desktop; typecheck/build web e prototipo, OpenAPI e architettura
allineati (0 errori, 35 avvisi). La prova browser usa un profilo sintetico separato.
Il [consolidamento precedente](research/2026-09-23-consolidamento-verifica.md)
resta una fotografia distinta.

## Limiti ancora aperti

- MCP esegue fuori dal percorso DBOS/outbox dei tool locali: un effetto esterno
  e la sua registrazione richiedono un contratto dedicato per esiti incerti.
- Nessuna stima preventiva affidabile dei token: una chiamata già ammessa può
  superare il cap; le chiamate successive sono bloccate quando il limite noto è
  raggiunto. Consumo sconosciuto non significa consumo nullo.
- Identità locale legata al launcher e al profilo attuale; provisioning
  multiutente e collaborazione fra installazioni non certificati.
- Cifratura operativa dell'intero profilo, gestione/recupero chiavi e upgrade o
  rollback di dati e runtime richiedono prove dedicate. Il driver SQLCipher
  disponibile non dimostra da solo protezione completa di database e file.
- Firma, notarizzazione, aggiornamento fra due release e Mac pulito non
  riverificati in questa tranche. Il test dell'updater simula Electron e feed.
- Lint globale ancora non verde per debito preesistente; restano 35 avvisi
  architetturali di dimensione e avvisi build sui chunk. Nessuna formattazione
  massiva dei file legacy è stata inclusa.
- La qualità delle decisioni del modello e la comprensibilità del flusso non
  sono certificate dal numero di test. Restano da analizzare con scenari reali,
  inclusi errori, ripresa dopo giorni e materiali che cambiano.

## Prossimo passo: parità Hermes, poi UX

La tranche file H11 aggiunge pagine, ricerca e modifiche approvate. Il terminale
può lasciare un comando Docker in esecuzione, leggerne lo stato, attenderlo,
arrestarlo, inviargli byte sullo stdin o rispondere alle richieste di un terminale
nuovo. Può anche eseguire un comando su questo computer, nella cartella del lavoro,
senza ereditare l'ambiente: non è un container. Può anche eseguire un comando
su un host SSH approvato, con la chiave pubblica del server fissata nell'approvazione
e senza copiare i file. Può anche leggere il testo di una pagina http pubblica,
rifiutando gli indirizzi privati, con memorizzazione temporanea in cache; può cercare
sul web pubblico, consultare provider dedicati con verifica delle chiavi e fallback di
salvataggio (rescue) su errore senza memorizzazione sticky dei risultati di emergenza,
e cercare post/profili pubblici su X con vincoli conformi a xAI. Può anche aprire un browser privato,
senza il profilo di Chrome di questo computer, leggere una pagina pubblica,
chiudere una finestra nativa senza confermarla, compilare un campo, salvare
una schermata di quella pagina, interagire con i controlli nei riquadri (iframe) pubblici
e chiudere solo quel processo. Non fotografa lo
schermo di questo computer. Accettare una finestra, scorrimento e visione restano
assenti. Può anche consultare memorie persistenti approvate (memory_recall), annotare
fatti importanti con dedup e limite di capacità (memory_remember), cercare nella sessione
(session_search) con vincoli temporali e autorizzazioni di conversazione, scoprire competenze
approvate (skill_search), caricarne le istruzioni complete su richiesta (skill_view) con quarantena
rigorosa per le bozze, e proporre nuove competenze apprese (skill_propose) in attesa di approvazione umana.
Restano aperti lo schermo completo,
Modal, Singularity, Daytona, Vercel, language server,
patch V4A e il resto della matrice. Non è parità completa.

## Uso reale e UX

I due ingressi — richiesta diretta e squadra aziendale — sono presenti nel
perimetro del rapporto operativo. Il ciclo resta limitato ai materiali selezionati:
web, shell, MCP generici, agenti pronti e collaborazione distribuita sono aperti.
Il confronto listini è una fixture tecnica, non il posizionamento.

La [guida](USO-HOMUN.md), la [matrice requisiti](specifications/STATO-IMPLEMENTAZIONE.md)
e gli scenari del [rapporto](research/2026-09-23-homun-operativo-verifica.md)
preparano l'analisi UX: ridurre passaggi, chiarire responsabilità e rendere semplice
riprendere il lavoro. La qualità va misurata con utenti del target, non dedotta
dai test. Il [confronto Hermes](research/2026-09-23-hermes-homun-utilizzo.md)
conserva lo snapshot di ricerca e rinvia alle implementazioni successive.


- **H34 surfaces (2026-09-24)**: SurfaceGatewayManager persiste sessioni, approvazioni,
  steering e artifact su SQLite; reconnect dopo restart del processo.

- **H35 hosted MCP (2026-09-24)**: `HostedMcpEngineRunner` crea lavoro e propose
  agent_run reali (`pending_approval`), senza dichiarare completed.

- **H40/H42 persistenza (2026-09-24)**: WriteApprovalGate e DeliverableLedger
  salvano su SQLite sotto HOMUN_DATA_DIR e sopravvivono al riavvio del processo.

- **H03/H04 e automazioni durevoli (2026-09-24)**: `/btw` raggiungibile via
  `POST .../agent-runs/{id}/side-question`; `initial_messages` nel propose usa
  PromptAssembler + `@` refs con cwd confinato in `agent-workspaces`. Heartbeat e
  loop persistono su `automation.sqlite`.

- **Backend reali e persistenza (2026-09-24)**: TTS macOS `say` e visione Ollama
  collegati alle API media quando disponibili; probe TCC macOS per computer-use
  senza dichiarare `ready` senza driver. Goal e sessioni di default su SQLite
  durevole sotto `HOMUN_DATA_DIR`.
  [Media](research/evidence/2026-09-24-media-backends/README.md).

- **Correzione falsi successi (2026-09-24)**: i percorsi motore per media, computer-use,
  canali, hosted MCP, Copilot ACP, Yuanbao/Meet e batch eval non dichiarano più successo
  senza backend reale; restituiscono `backend_unavailable` o errore tipizzato.
  [Guardie](research/evidence/2026-09-24-false-success-guards/README.md).
  [Audit](research/2026-09-24-parity-audit-indipendente.md).
  Le righe H16/H33/H35/H39/H41/H43/H45 della matrice sono `partial` (honesty only);
  i backend reali e il collegamento prodotto restano aperti. Le voci «Parità … verificata»
  sotto per quelle righe sono storiche e non sostituiscono la matrice corretta.

- **Da fare successivamente (UI i18n)**: localizzazione multilingua di tutti i copy dell'interfaccia utente (UI copy) in modo che ciascun utente possa fruirne nella propria lingua. Registrato per la fase successiva alla parità funzionale con Hermes.
- **H33 channel HTTP transports (2026-09-24)**: webhook POST when URL set; Telegram/Discord/Slack/WhatsApp `send` use real Bot/Graph APIs when tokens (and WhatsApp phone_number_id) are configured; unconfigured → `backend_unavailable`. `gateway_manage adapter_send` reports `failed` when delivery did not happen.
- **H35 idempotency + H27 complete_tick (2026-09-24)**: OpenAI API Idempotency-Key store on SQLite; loop `complete_tick` on agent finish.
- **H10 cloud backends (2026-09-24)**: Modal/Daytona/Singularity/Vercel/managed Modal catalogued with typed unavailability; no invented sandboxes. `GET /v1/operations/terminal-backends`.
- **H28/H29 due-fire + Chronos (2026-09-24)**: `/v1/cron/due` and `/v1/cron/fire-due`; Chronos reports `backend_unavailable` until `HOMUN_CHRONOS_URL` is set.
- **H32 hosted rooms + cron runner (2026-09-24)**: rooms/events on SQLite; cron prompt runs stage pending_approval agent runs via CronAgentRunner. [Evidenze](research/evidence/2026-09-24-hosted-rooms-durability/README.md).
- **H32 pairing durability (2026-09-24)**: DM pairing codes and allowlists persist under `HOMUN_DATA_DIR/gateway/`. [Evidenze](research/evidence/2026-09-24-gateway-pairing-durability/README.md).
- **H26/H27 automation dispatch (2026-09-24)**: due heartbeat/loop prompts enter `agent_run` via `_steering` on claim. [Evidenze](research/evidence/2026-09-24-automation-dispatch/README.md).
- **H12 product wiring (2026-09-24)**: approved workspace writes snapshot via `CheckpointManager` under `HOMUN_DATA_DIR/checkpoints` before mutation; delegation can isolate with git worktrees when `worktree_isolation` is set. [Evidenze](research/evidence/2026-09-24-h12-product-wiring/README.md).
- **H28/H29 CronStore (2026-09-24)**: jobs/occurrences/incidents/deliveries persist on `cron.sqlite`; prompt jobs without agent runner return `backend_unavailable` (no synthetic success). Chronos and due-fire dispatcher open. [Evidenze](research/evidence/2026-09-24-cron-durability/README.md).
- **Parità Hermes H28/H29 verificata**: pianificazione cron durevole (`cronjob_manage`) con parsing puro Python a 5 campi, intervalli relativi, timestamp ISO one-shot e trigger ad eventi; validazione preflight; iniezione del contesto a catena (`context_from`); esecuzione script e agente con pin di modello/provider; quota hold con pausa automatica e sblocco; tracciamento incidenti con deduplicazione dei fallimenti e risoluzione; code di consegna esterna. Suite: 1050 test motore passati, 226 test web passati, architettura conforme e build web pulita.
- **Parità Hermes H30/H31 verificata**: gestione e persistenza delle sessioni (`session_manage`, `SessionManager`, `SessionStorage`) con ciclo di vita CRUD, ripristino cartella di lavoro (cwd) alla ripresa (`resume`), rewind dei turni con disattivazione soft che preserva l'autorità dello storico, biforcazioni (`fork`) con snapshot dei messaggi e tracciamento genealogico (antenati/figli), esportazione protetta con rimozione automatica di token/credenziali sensibili (`redact_secrets`), importazione trascrizioni senza deriva identitaria, pacchetto di handoff contestuale, motore SQLite con modalità WAL e timeout busy, indicizzazione full-text FTS5 con trigger di sincronizzazione, controlli di integrità forense (`PRAGMA integrity_check`) con autoriparazione e accounting granulare dei token e costi per sessione e profilo. Suite: 1059 test motore passati, 226 test web passati, architettura conforme e build web pulita.
- **Parità Hermes H32/H33 verificata**: runtime gateway (`gateway_manage`, `GatewayPairingManager`, `TurnLeaseManager`, `HostedRoomManager`, `ChannelRegistry`) con accoppiamento codici DM NIST/OWASP (alfabeto non ambiguo a 8 caratteri, TTL 1h, rate limiting, blocco a 5 fallimenti consecutivi), approvazioni/revoche operatore, liste consentite/bloccate, serializzazione esclusiva dei turni per sessione/canale/argomento con timeout fail-closed (`TurnLeaseTimeout`), stanze di discussione multi-agente con ruoli di appartenenza, log eventi append-only e isolamento tematico, e adattatori multicanale normalizzati (Telegram, Discord, Slack, WhatsApp, Webhook relay) con rilevamento messaggi diretti, estrazione allegati multimediali, routing thread e invio protetto da lease e autorizzazione. Suite: 1076 test motore passati, 226 test web passati, architettura conforme e build web pulita.
- **Parità Hermes H03/H04 verificata**: domande collaterali contestuali (`SideQuestionRunner`, `/btw`) disaccoppiate dallo storico principale (nessun turno sintetico, nessuna invalidazione cache o rischio di alternanza ruoli, soppressione totale degli strumenti e attribuzione dei token/costi al run genitore); assemblaggio stratificato dei prompt (`PromptAssembler`, `initial_messages`) con precedenza documentata delle istruzioni di workspace (`AGENTS.override.md` > `AGENTS.md` > `.homun/AGENTS.md` > `CLAUDE.md` > `.cursorrules`), discesa per sottocartelle (ancestor walk), scansione di sicurezza contro prompt-injection che blocca file di progetto non fidati e segnala `SOUL.md`, manifesto per-file con stime token e stato di caricamento, ed espansione dei riferimenti `@file` (con intervalli di riga), `@folder`, `@diff`, `@staged`, `@git`, `@url` con filtraggio percorsi sensibili e protezione SSRF su IP privati. Suite: 1089 test motore passati, 226 test web passati, architettura conforme e build web pulita.
- **Parità Hermes H37 verificata**: architettura di estensibilità tramite plugin (`PluginManager`, `PluginLoader`, `PluginStorage`, endpoint `/v1/plugins`), supporto manifesti v1 e v2, isolamento moduli dinamico, registro capacità (tools, hooks, providers, platforms, commands, skills, panels, secrets), hook a policy con blocco fail-closed, ciclo di vita enable/disable con pulizia completa e ricaricamento a caldo della configurazione, e rispetto del contratto di ritenzione dati persistente fuori dall'albero di installazione (`plugin-data/<name>/`). Suite: 1121 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H38 verificata**: registro provider di inferenza dichiarativo (`ProviderRegistry`, `ProviderProfile`, endpoint `/v1/providers`, `/v1/credentials`), adattamento automatico sintassi del ragionamento (top-level vs extra_body vs thinking budget), adattamento elementi multimediali con fallback testuale per modelli non-vision e flattening dei risultati dei tool, adattamento schemi JSON strict, pool multi-credenziali thread-safe con rotazione round-robin, gestione cooldown automatico su 429/quota e classificazione token morti su 401, e router ausiliario con catene di fallback per compiti ausiliari e tracciamento storico completo degli audit. Suite: 1128 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H39 verificata**: integrazioni opzionali per runtime alternativi e gateway (`CodexAppServerAdapter`, `CopilotAcpClient`, `RelayRuntime`, `ManagedToolGateway`, endpoint `/v1/runtimes`), adattamento protocollo JSON-RPC Codex App-Server con streaming eventi e traduzione comandi/tool, client GitHub Copilot ACP con estrazione blocchi `<tool_call>` e verifica binario su PATH, proxy NeMo Relay aziendale con isolamento sessioni e iniezione header `x-dynamo-session-id`, e gateway per tool cloud gestiti con autenticazione Bearer e segnalazione esplicita del gap di servizio quando non configurato, senza alcuna dipendenza runtime da Hermes. Suite: 1136 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H40 verificata**: sicurezza del nucleo e approvazioni (`check_path_safety`, `validate_within_dir`, `is_safe_url`, `redact_secrets`, `VaultStore`, `WriteApprovalGate`, endpoint `/v1/safety`), confinamento cartelle con blocco traversal `..` e caratteri di controllo non sicuri, protezione percorsi sensibili (`.env`, chiavi SSH, shadow), prevenzione SSRF su IP privati/loopback ed endpoint di metadati cloud (`169.254.169.254`, `metadata.google.internal`), normalizzazione URL IDNA/URI, rilevamento credenziali in userinfo e query params, mascheramento token e scrubbing chiavi private, vault credenziali crittografato a riposo con Fernet e handle opachi per i modelli con registrazione automatica nel redattore, e gate di approvazione scritture con garanzia di esecuzione strettamente singola e rifiuti verificabili a zero effetti collaterali. Suite: 1142 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H41 verificata**: fornitori e strumenti multimediali (`VisionAnalyzer`, `ImageGenerator`, `VideoGenerator`, `SpeechToTextTranscriber`, `TextToSpeechSynthesizer`, `VoiceSession`, `WakeWordDetector`, endpoint `/v1/media`), preparazione e normalizzazione sorgenti per analisi visiva di immagini e sequenze di fotogrammi video, generazione e modifica multi-immagine con mappatura catalogo e aspect ratio unificati, generazione video con vincoli e clamping di durata e risoluzione, trascrizione vocale STT con validazione formati audio e supporto fornitori locali/cloud, sintesi vocale TTS con normalizzazione e rimozione markdown e streaming a blocchi frasali, e modalità vocale continua con rilevamento frasi di attivazione ("Hey Homun" / "Hey Hermes") e interruzione vocale immediata (barge-in) al parlato dell'utente. Suite: 1149 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H42 verificata**: comportamento artefatti del nucleo, modalità di consegna e protezione blocchi di codice (`DeliverablePolicy`, `DeliverableExtractor`, `DeliverableLedger`, endpoint `/v1/deliverables`), classificazione deterministica formati deliverable (PDF, fogli di calcolo, immagini, audio, presentazioni), confinamento di sicurezza nella cartella di lavoro con blocco categorico di file sorgente, eseguibili e segreti (.py, .sh, .env, .log), esclusione rigorosa dei blocchi di codice fenced (```...```) e backtick inline (`...`) dall'estrazione per evitare che percorsi usati negli esempi di codice vengano trattati come deliverable, sostituzione sicura con testo in prosa [nomefile], e registro consegne thread-safe con ricevute immutabili e garanzia at-most-once. Suite: 1153 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H43 verificata**: integrazioni opzionali (`HomeAssistantAdapter`, `DiscordAdapter`, `FeishuAdapter`, `YuanbaoAdapter`, `SpotifyAdapter`, `MeetingManager`, `parse_teams_meeting_resource`, endpoint `/v1/integrations`), validazione sintassi e blocco domini pericolosi per Home Assistant (prevenzione shell/SSRF), introspezione server Discord, gestione intent e azioni reversibili (pin/unpin messaggio, assegnazione/rimozione ruolo) con risposte limitate (4MB/64KB), lettura documenti e gestione thread commenti Feishu/Lark, interazione gruppi Yuanbao con invio sticker, formattazione menzioni standardizzata e disambiguazione destinatari, controllo riproduzione e libreria Spotify reversibile (salvataggio/rimozione brano), gestione chiamate Google Meet con trascrizione e sintesi vocale realtime, e parsing risorse meeting Microsoft Teams Graph. Suite: 1160 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H44 verificata**: operazioni, profili e ciclo di vita daemon (`ProfileOperationsManager`, `ConfigLifecycleManager`, `DoctorDiagnostics`, `DaemonManager`, endpoint `/v1/operations`), gestione ciclo di vita profili con isolamento cartelle e nomi alfanumerici, pacchetti di distribuzione con verifica integrità SHA256 e import/export sicuro, migrazioni schema di configurazione con backup automatici e supporto v1->v2 idempotente, diagnostica di sistema (Doctor) con controlli piattaforma (Python, SQLite JSON1/FTS5), strumenti sviluppatore (git, ripgrep, node), backend terminale (Docker, shell locale, SSH), permessi storage e integrità database con autoriparazione, e gestione del daemon con tracciamento PID, rilevamento PID obsoleti, terminazione pulita SIGTERM e riavvio controllato. Suite: 1165 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H45 verificata**: ricerca opzionale, benchmark, compressione traiettorie e osservabilità (`TrajectoryStore`, `TrajectoryCompressor`, `BatchEvalRunner`, `ObservabilityCollector`, endpoint `/v1/research`), persistenza sicura file-lock (flock) in formato ShareGPT con conversione tag scratchpad (`<REASONING_SCRATCHPAD>` a `<think>`) e rilevamento incompleti, compressione traiettorie su budget token con protezione della testa (sistema, primo utente, prima azione gpt, primo tool) e della coda senza spezzare mai le coppie `<tool_call>`/`<tool_response>`, esecutore concorrente di dataset di benchmark con pool di worker configurabile, checkpointing JSONL per ripresa (`--resume`) e aggregazione statistica dei tool, e tracciamento distribuito (span e trace) con esportazione compatibile OpenTelemetry e Langfuse. Suite: 1170 test motore passati, 226 test web passati, architettura conforme.
- **Parità Hermes H46 verificata**: catalogo e superfici opzionali (`CompanionManager`, `AchievementTracker`, `TourAndTipManager`, `DiskCleanupEngine`, `SecurityGuidanceScanner`, `CatalogPacksManager`, endpoint `/v1/catalog`), compagno virtuale persistente con meccanica dei bisogni, livelli ed estetiche skin ASCII con toggle esplicito, registro e sblocco traguardi (achievements) con calcolo punteggio, tour guidato di onboarding e consigli contestuali (`/btw`, menzioni selettive), pulizia disco del workspace con scansione dry-run dei file temporanei/cache/log e rimozione selettiva sicura, guida di sicurezza contro pattern pericolosi (piping curl a shell, chmod 777, token in chiaro), e manifesto completo dei pacchetti di competenze del catalogo con installazione e disinstallazione atomica senza omissione di extra. Suite: 1177 test motore passati, 226 test web passati, architettura conforme.








