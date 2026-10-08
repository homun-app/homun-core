# Stato verificato di Homun 2

Aggiornato il 22 settembre 2026 dopo la tranche «fondazioni prodotto» (audit UX
D1–D12, piani multi-fase con strumenti reali e chiusura con esito, gestione
agenti/team, impostazioni ristrutturate con suggerimenti modelli, budget e
scadenze per lavoro, revisione piano da UI, libreria Documenti, routine a
motore). Tranche precedente (21 settembre 2026): scroll che non interrompe la lettura (policy pura + hook di ancoraggio al fondo), attese del modello oneste nel transcript (fasi vere + secondi trascorsi) e recupero guidato dai 409 a versione stantia sulle azioni dei tool. Questo è il riferimento sintetico corrente; i rapporti in `research/` conservano prove e limiti delle singole tranche. I numeri sotto provengono dall'ultima verifica, non da esecuzioni ripetute durante l'aggiornamento documentale.

## Funziona nel perimetro verificato

- Motore Python persistente: comandi versionati, fingerprint/replay, transazioni, policy correnti, outbox e recovery DBOS.
- Sessione locale autenticata e legata all'identità del launcher; letture e replay filtrati secondo le policy implementate. Non equivale ad autenticazione multiutente esterna.
- Materiali gestiti con originali immutabili, ingestione e recupero; backup offline v2 di workspace, originali, DBOS e ricevute.
- Chat con storico persistito e contesto autorizzato; provider reale locale Qwen3.5:4b provato via API e nella GUI.
- **Rifiuto onesto dei risultati non eseguibili:** se la richiesta chiede un risultato fuori dalle capacità eseguibili registrate (per esempio creare un catalogo), la proposta resta di preparazione (`general`) e dichiara nel rationale cosa Homun sa fare oggi (confronto CSV, lettura documento) e cosa mancherebbe; mai forzare il risultato in un'attività inadatta (22/9, dopo la diagnosi sul profilo reale: una richiesta di catalogo consegnata come confronto listini).
- **Distinzione domanda/lavoro:** il backend classifica senza stato (`POST /intake/classify`, solo persone) e il frontend instrada; una domanda viene risposta in chat senza creare lavori o collaboratori, una richiesta di risultato produce la proposta di accordo. Le precisazioni su una proposta in attesa restano lavoro; il default conservativo è lavoro; ogni errore di classificazione ricade sul percorso di proposta duraturo.
- Intake: richiesta conservata, titolo e obiettivo distinti, proposta di collaboratore reale o nuovo profilo, conferma prima dell'assegnazione. Creare un profilo non concede strumenti/accessi.
- **Accordo stabile nelle riformulazioni:** il modello dichiara i campi modificati (`changed_fields`) e il motore conserva strutturalmente gli altri dall'ultimo brief valido; cambiare solo il collaboratore non altera obiettivo, risultato, vincoli o capacità. Ogni proposta espone il diff calcolato dal backend (`changes`) e la scheda mostra «cosa cambia / cosa resta invariato».
- Scheda accordo e riepilogo coerenti: azioni offerte solo quando il backend le accetta (bozza senza piano/artifact), scheda storica marcata quando obiettivo o titolo divergono, nessuna sincronizzazione silenziosa.
- **Lettura non interrotta:** aggiornamenti e caricamenti non azzerano più lo storico; il transcript si ricarica solo a cambio lavoro o su richiesta esplicita, conservando il contenuto visibile.
- **Scroll ancorato alla lettura:** il contenuto nuovo segue solo se chi legge è al fondo (policy pura testata + `useChatAutoScroll`); cambio lavoro = un salto istantaneo sull'ultimo messaggio; refresh, caricamenti e completamenti non trascinano mai chi legge sopra; il proprio messaggio segue sempre.
- **Attese del modello oneste nel transcript:** il turno in volo mostra la fase reale («sta leggendo il messaggio» → «sta preparando la proposta di accordo») con secondi trascorsi e, oltre 45 s, l'avviso che il modello può impiegare circa un minuto; niente percentuali finte; il messaggio della persona non scompare più se il turno fallisce; un invio in uscita riaggancia sempre la vista al fondo, anche partendo da metà lettura.
- **Interpretazione tollerante ai modelli «thinking»:** il parser dell'interpretazione usa l'estrattore condiviso `models/json_payload.py` (stesso dell'intake): JSON con prosa attorno o secondi blocchi in coda non producono più `provider_unavailable` intermittente sui messaggi in lavori confermati (regressione osservata col modello reale e corretta).
- **Recupero guidato dai 409:** le azioni dei tool (confronto, lettura, catena) con versione stantia ricaricano lo stato, rinnovano gli id operazione e mostrano una nota guidata invece dell'errore secco; l'approve respinto (permanentemente non approvabile per contratto motore) nasconde la proposta stantia e riporta la scheda alla selezione; nessun retry automatico silenzioso.
- **Un turno alla volta, detto ad alta voce:** un secondo invio mentre Homun sta ancora elaborando viene rifiutato con un avviso onesto (attendi la risposta o premi Annulla) invece di abortire silenziosamente il turno in volo.
- **Etichette di stato oneste:** una bozza con accordo confermato si legge «Concordato · in preparazione» (pannello e lista lavori), non più «Da concordare».
- **Registro delle capacità:** fonte singola in `domain/capabilities.py` (id, tipo, versione tool, input/output, effetti, prerequisiti, limiti, timeout); il confronto CSV e la lettura attingono versione e limiti da lì; `GET /v1/workspaces/{ws}/capabilities` espone il catalogo con disponibilità reale per attore (materiali idonei leggibili); la sintesi dell'intake riceve il catalogo reale senza segnali di disponibilità; con roster vuoto o agente unico il motore applica un collaboratore confermabile deterministico.
- **Seconda capacità eseguibile — lettura materiale:** `read_material` (versionata `material-read-v1`) con proposta→approvazione→esecuzione DBOS→artifact di lettura (estratto limitato 8.000 caratteri, hash, provenienza) in revisione umana; fonte materiale condivisa con il confronto CSV (stessa verifica di identità/hash/permessi); cambio del materiale invalida l'approvazione; retry e riavvio non duplicano l'artifact. Scheda «Leggi un materiale» nella chat.
- **Collegamento capabilities ↔ registro:** `AgentProfile.capabilities` validato contro il registro; il roster passato al modello include i collegamenti; la raccomandazione è corretta engine-side a favore dell'agente collegato quando esiste; l'agente creato dall'intake porta i collegamenti; la Squadra mostra «Può eseguire» con etichette dal registro.
- **Identità professionale dei collaboratori:** `AgentProfile` esteso con responsibility, specializations, method, tone e autonomy_mode (versionati, validati, revisionabili con agent.update); l'intake propone profili completi con nome proprio italiano e identità strutturata; vista Squadra con schede ricche (avatar, chip specializzazioni, badge autonomia); riepilogo destro onesto («Homun coordina finché non confermi un collaboratore», spiegazione quando l'obiettivo non c'è ancora).
- **UX della catena e materiali nel riepilogo:** scheda «Leggi più materiali in una volta» nella chat (selezione 2–8 materiali registrati, una sola approvazione che enumera le versioni esatte, avanzamento per documento); sezione «Materiali del lavoro» nel riepilogo destro con riferimenti e hash — allineata alla direzione UX approvata e al template del prototipo.
- **Tool chain — primo loop multi-tool:** un turno compone più invocazioni di capacità approvate con un'unica approvazione persona che enumera ogni effetto (digest sull'intera sequenza, fonti rivalidate prima dell'avvio); esecuzione DBOS sequenziale riusando gli execute() degli strumenti; continuazione meccanica fra i passi registrata negli eventi; fallimento al passo N conserva gli artifact precedenti e blocca i successivi; V1 monocapacità (2–8 passi), via API.
- **Selettore materiali esistenti:** le schede lettura e confronto offrono «Usa i materiali del progetto» accanto al caricamento: i riferimenti (nome·versione·byte) si scelgono da ciò che è già registrato, senza duplicare upload; i percorsi da-id non producono mai ingestioni. Primo incremento verso il loop multi-tool.
- **Confini della delega operativa (passo D completato):** l'approvazione dell'esecuzione di azioni concrete (confronto CSV, lettura materiale) richiede una persona, anche quando il proprietario del lavoro è l'agente delegato; i delegati hanno cap di budget propri (`BudgetAllocation`: limite e contatori per attore dentro la busta del lavoro, impostabili con `work.set_budget`, contatori spesi conservati) — un delegato esaurisce il proprio sub-cap senza toccare la busta degli altri; l'agente delegato con grant conduce turni di chat supervisionati sotto il proprio cap, le azioni restano approvazione umana.
- **Contesto autorizzato esteso (passo D):** quando la chat è legata a un lavoro, il contesto composto per il modello include un preambolo autorizzato e limitato — stato del lavoro, accordo confermato, riferimenti materiali (versione e hash, mai il contenuto) e memoria approvata pertinente — tracciato nel manifest (v2) e rivalidato prima di pubblicare effetti: un materiale che cambia versione invalida l'interpretazione in volo; i manifest legacy continuano a validare.
- **Budget per lavoro con riserve atomiche (passo D):** `WorkBudget` persistito (tentativi e token, cap predefinito 40 tentativi); riserva committe prima della chiamata al provider, riconciliazione con token reali o come incognito (mai zero), rilascio, recupero all'avvio dei pendini di processi morti; esaurimento tipizzato (`budget_exhausted`, HTTP 429), mai auto-risolto né auto-ritentato: si alza solo con `work.set_budget` esplicito. **Collegato a tutto il ciclo di modello del lavoro**: sintesi e classificazione dell'intake, interpretazione dei messaggi (tentativi di retry inclusi) ed estrazione del piano; le conversazioni senza lavoro restano fuori. `GET /works/{id}` espone i contatori.
- **Prompt esterni e multilingua:** i prompt vivono come file nel pacchetto (`engine/src/homun/prompts/`, it+en) caricati da uno store con fallback linguistico e sostituzione letterale dei segnaposto; la lingua del workspace è configurabile (`HOMUN_LANGUAGE`) e ogni richiesta può dichiararne una (`language` su intake); il classificatore domanda/lavoro rileva la lingua e il frontend la inoltra automaticamente alla proposta; i file prompt sono input di build e ricevuta del pacchetto desktop.
- Primo lavoro concreto: confronto deterministico di due listini CSV, approvazione dell'azione, report/CSV, revisione umana e recupero dopo riavvio senza duplicati.
- Riepilogo destro compatto, modifica esplicita, squadra reale nel percorso motore, diagnostica richiudibile.
- App Electron macOS arm64 con Python incorporato, archivio estratto e smoke autonomo verificati.

## Prove di riferimento

| Verifica | Ultima evidenza |
| --- | --- |
| Motore | 454 test passati, 1 saltato (453 + regressione parser interpret: l'output dei modelli thinking con prosa attorno al JSON non fa più fallire l'interpretazione; estrattore tollerante condiviso con l'intake in `models/json_payload.py`) |
| Frontend | 193 passati (policy autoscroll con evento own-send, recupero 409 con messaggi differenziati prepare/approve, oltre ai 183 precedenti), typecheck e build web/prototipo riusciti |
| Desktop | 8 passati con motore incorporato |
| Architettura | 0 errori, 29 avvisi di dimensione legacy |
| Contratto API | OpenAPI allineata (intake con `changed_fields`/`changes`/`classify`+`language` e vocabolario `read_material`; catalogo capacità; route `material-reads`) |
| Modello reale | Qwen3.5:4b via API e GUI: domande → risposta in chat senza proposta; CSV → `compare_csv`; lettura documento → `read_material` con collaboratore; coordinamento → `general` (matrice 3/3); flusso lettura completo fino all'artifact in revisione; inglese esteso → brief in inglese; italiano → italiano; cambio solo collaboratore (brief identico, diff solo staffing); budget con token reali su intake (2303/203) e chat (440/114), esaurimento duraturo e 429, ripristino esplicito; risposta in chat ancorata a stato lavoro, riferimento materiale e accordo dal preambolo autorizzato; 22/9 con glm-5.3-flash:cloud: richiesta di catalogo → `general` con rationale onesto dei limiti, richiesta di confronto → `compare_csv` (percorso positivo invariato) |
| GUI | Browser su motore temporaneo (profilo usa-e-getta, proxy same-origin): domanda pura → risposta in streaming con attesa onesta fino a 80 s e nota dei 45 s; richiesta di lavoro → proposta; raffinamento → fase «prepara la proposta» con contatore e scroll rimasto a 0 durante l'arrivo del contenuto; 409 reale su approve dopo rinomina → nota guidata, proposta stantia nascosta, selezione ripristinata, ripreparazione e approvazione → report con i numeri dell'oracolo demo; secondo passaggio regressioni: invio da lettura sopra riaggancia la vista al fondo, il messaggio che falliva con `provider_unavailable` ora risponde in GUI e via probe API |
| Pacchetto | Build desktop riuscita con prompt e nuovi moduli incorporati, CRC ZIP verificato, 8/8 test |

Build di riferimento: `dist/desktop/2026-09-22T05-52-17-819Z/Homun-darwin-arm64/Homun.app` (nome in UTC; include tutte le correzioni della giornata — stabilità, regressioni, gate invio, etichette — con motore e web aggiornati; 8/8 test desktop con motore incorporato; candidato locale non firmato/notarizzato).

Vedi [prove complete e limiti della tranche stabilità conversazione](research/2026-09-21-stabilita-conversazione.md), la [tranche capability links](research/2026-09-21-capability-links.md), la [tranche identità collaboratori](research/2026-09-21-identita-collaboratori.md), la [tranche UX della catena](research/2026-09-20-ux-catena-materiali.md), la [tranche tool chain](research/2026-09-20-tool-chain.md), la [tranche selettore materiali](research/2026-09-20-selettore-materiali.md), la [tranche confini della delega](research/2026-09-20-confini-delega.md), la [tranche contesto autorizzato](research/2026-09-20-contesto-autorizzato.md), la [tranche budget](research/2026-09-20-budget-lavoro.md), la [tranche lettura materiale](research/2026-09-20-lettura-materiale.md) e la [ricognizione Hermes e altri sistemi](research/2026-09-20-ricognizione-hermes-altri.md). Le build precedenti restano in `dist/desktop/` come prove storiche.

## Ancora aperto

- **Piano multi-fase** (priorità 1 aperta del 21/9): un lavoro deve poter dichiarare fasi (raccolta → confronto → sintesi) con più collaboratori e passaggi visibili; il motore ha già `plan.propose` ma l'intake non lo usa. Richiede una proposta di design validata da Fabio prima del codice. Stabilità della conversazione (scroll, attese) e 409 con recupero guidato sono invece chiusi.
- La UI della catena copre le letture multiple (le catene compare_csv restano via API); il riepilogo mostra i materiali del progetto della conversazione senza link al pannello; le skill portabili restano da fare; le allocazioni di budget si impostano solo via comando/API (nessuna UI); un delegato senza allocazione esplicita spende dalla busta comune.
- Il budget copre il ciclo di modello del lavoro (intake, interpretazione, piano); restano fuori lo stream presentazionale e le chiamate senza lavoro. I ritardi di retry possono superare la stima prenotata di un'unità (documentato); nessuna stima preventiva di token; niente cap propri per delegati (arrivano con la delega operativa); il budget non è ancora nel riepilogo UI (solo via API).
- Il picker materiali mostra il progetto della conversazione (non più progetti) e non si aggiorna da caricamenti esterni senza riapertura. La selezione della capacità da parte del 4B dipende dalle righe di esempio nel prompt: nuove capacità richiederanno esempi e riverifica della matrice.
- **Multilingua:** la UI resta italiana (i18n delle stringhe non richiesto); il contenuto del registro capacità è in italiano; con il modello locale 4B richieste molto brevi in altra lingua ricadono sulla lingua del template (limite del modello, non dell'infrastruttura); template oltre it/en da aggiungere con il fallback a protezione.
- Budget aggregati con riserve atomiche e loop operativo multi-tool (passo D): la lettura e il confronto sono due capacità isolate, non ancora una catena; la disponibilità del registro non è ancora consumata dalla UI.
- Qualità semantica della classificazione domanda/lavoro non certificata su corpus ampio; entrambi gli errori sono recuperabili e il default è conservativo (lavoro). Le risposte alle domande usano la pipeline di interpretazione esistente: una risposta osservata mostrava i «Candidati» del roster in coda (formato preesistente da raffinare).
- La classificazione e la sintesi del brief non vedono lo storico conversazionale precedente (contesto autorizzato = passo D); una chiamata di classificazione in più per i primi messaggi che richiedono un accordo.
- Qualità semantica della classificazione `changed_fields` non certificata su corpus ampio: la garanzia strutturale è engine-side, ma una precisazione male interpretata può conservare troppo (recupero con nuova precisazione) o mostrare nel diff un campo non inteso (mai applicato senza conferma). I valori sconosciuti sono scartati senza audit dell'eco del modello.
- Il ciclo di refresh e l'ancoraggio dello scroll hanno test automatici delle politiche (moduli puri) e verifica GUI, ma non un test mount/unmount React dedicato; l'upload file in GUI non è automatizzabile col browser in-app (il 409 è stato verificato con i materiali di progetto, non con upload diretti); la proposta respinta da un approve 409 riappare nell'elenco dopo un reload completo finché non è superata (riapprovarla riproduce lo stesso recupero guidato).
- Loop operativo multi-tool, budget aggregati atomici, delega estesa e skill portabili. `general` indica preparazione; `compare_csv` è la capacità concreta provata.
- Parità completa fra superfici UI e motore: restano funzioni del prototipo e debito strutturale.
- Cifratura operativa e recupero chiavi, Keychain, identità multiutente/peer, contratto di upgrade/rollback DBOS.
- Firma Developer ID, notarizzazione, aggiornamenti/rollback, Mac pulito e altre piattaforme. Il candidato locale non è una release certificata.

## Da dove continuare

La [specifica di passaggio](handoff/2026-09-19-ripresa-sviluppo-homun.md) resta la mappa: priorità B e C completate; **passo D completato** (budget con riserve atomiche su tutto il ciclo di modello, cap per delegati, contesto autorizzato esteso con rivalidazione identità, delega operativa delimitata con approvazioni umane); le priorità 2 (stabilità della conversazione) e 3 (409 con recupero guidato) del prompt del 21/9 sono chiuse dalla [tranche stabilità conversazione](research/2026-09-21-stabilita-conversazione.md), insieme alle regressioni emerse in verifica. **Prossimo passo: il piano multi-fase (priorità 1 del 21/9)** — la [proposta di design](superpowers/specs/2026-09-21-piano-multi-fase-design.md) è pronta e attende la validazione di Fabio (tre decisioni aperte: conferma del piano separata, chi compone il piano, revisione per fase) prima di qualsiasi codice; poi le skill portabili. La [ricognizione aggiornata di Hermes e degli altri sistemi](research/2026-09-20-ricognizione-hermes-altri.md) (snapshot `6882320d5909`) raffina il design del passo D (contatori granulari inclusi token di cache, cap propri per delegati, riconciliazione delta/cumulativa, fallire-in-chiuso sulle approvazioni configurabili) e conferma: transcript canonico immutabile, memoria come versioni con diff, proposta-prima-di-esecuzione. L'architettura Pydantic AI + DBOS non è cambiata.

I rapporti precedenti sono fotografie storiche: i conteggi di test, gli hash dei pacchetti e i problemi allora aperti non vanno letti come stato corrente. Non cancellare queste prove né sostituirne i risultati con numeri di altre esecuzioni.


## Fondazioni prodotto (verificato il 22/9)

- **Piani multi-fase end-to-end:** l'intake può dichiarare fasi (`plan_steps`,
  validate: capacità del registro, assegnatari risolvibili); la conferma
  pubblica il piano accettato (lavoro Pronto); i materiali attesi pronti
  fanno proporre il passo dal lavoro stesso (annuncio una-tantum); le fasi
  eseguibili girano sui tool reali (confronto/lettura) senza secondo piano;
  l'approvazione di una fase intermedia avanza, l'ultima chiude con esito
  («Completato», risultato in archivio, nessun invio esterno).
- **Gestione agenti e team:** schede Squadra modificabili (identità,
  autonomia, capacità, connessione modello per collaboratore) e team con
  coordinatore (creazione, modifica, archiviazione) sui comandi versionati.
- **Impostazioni ristrutturate:** Modelli (collegamento) separato da Budget e
  routing; Persone e accessi lite; Plugin e capacità dal catalogo reale con
  prontezza; Automazioni oneste. Suggerimenti modelli per attività dal
  catalogo locale reale (euristiche dichiarate, non benchmark) con collegamento
  in un clic.
- **Budget, scadenze, revisione piano, documenti:** budget per lavoro con
  contatori onesti e limite esplicito; scadenze reali (`work.set_due`) con
  avviso scaduto e conteggi giornata in Compiti; aggiunta/rimozione fasi da
  UI (le completate restano storia); libreria Documenti (ricerca, filtro
  progetto, download) su tutti gli artefatti approvati.
- **Routine a motore:** entità Routine + comandi versionati
  (create/pause/resume/stop/update/skip_next); ricorrenze DBOS cron che
  creano lavori supervisionati dal modello (idempotenti per istante, guard
  sullo stato di dominio a ogni scatto); «Rendi ripetibile» dai lavori
  completati con cadenza in linguaggio naturale e anteprima delle prossime
  esecuzioni; spazio Automazioni con pausa/riprendi/salta/termina/modifica.
- **Superfici verificate:** web (percorsi end-to-end ripercorsi dal vivo) e
  shell Electron (percorso guida A→Z dopo il flag di accessibilità).
