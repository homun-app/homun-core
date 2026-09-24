# Stato verificato di Homun 2

Aggiornato il 24 settembre 2026 con il primo backend terminale Docker proprio
del nucleo nativo. Lo stato precedente e i rapporti datati conservano le prove storiche.
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
rifiutando gli indirizzi privati, e può cercare sul web pubblico. I provider
nominati, la cache e X restano assenti. Può anche aprire un browser privato,
senza il profilo di Chrome di questo computer, leggere una pagina pubblica,
chiudere una finestra nativa senza confermarla, compilare un campo, salvare
una schermata di quella pagina, interagire con i controlli nei riquadri (iframe) pubblici
e chiudere solo quel processo. Non fotografa lo
schermo di questo computer. Accettare una finestra, scorrimento e visione restano
assenti.
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
