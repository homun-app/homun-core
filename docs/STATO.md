# Stato verificato di Homun 2

Aggiornato il 23 settembre 2026 con registro strumenti e trasporto MCP
del nucleo nativo. Lo stato precedente e i rapporti datati conservano le prove storiche.
Una verifica del sorgente non aggiorna l'app installata.

## Capacità presenti

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

## Evidenze della tranche corrente

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

## Prossimo passo: uso reale e UX

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
