# 05 — Accettazione, decisioni e realizzazione

Stato: v0.1 da analizzare. [Indice](README.md).

## QA-01 — Matrice dei requisiti

| ID | Prova osservabile | Esito richiesto |
|---|---|---|
| PR-01 | Domanda semplice, poi richiesta operativa nella stessa chat | Risposta normale, poi proposta di lavoro senza chiedere categorie astratte |
| PR-02 | Chat senza progetto, trasformazione in progetto, seconda chat | Identità e storia conservate, contesti separati |
| PR-03 / AG-04 | Inserire traduttore dopo un passo concluso | Nuova revisione con impatto esplicito, risultato precedente non riscritto |
| PR-04 | Giulia riceve richiesta di listino sull'altra app | Notifica apre upload corretto; una risposta valida sblocca lo stesso passo |
| PR-05 / AG-06 | Fabio approva versione 1, agente genera versione 2 | Versione 2 non risulta già approvata; nessun invio implicito |
| PR-06 | 100 file, nomi lunghi, filtro, bulk link/delete | Nessun overflow; destinazione e accesso chiari; eliminazione invalida indici |
| PR-07 / AG-01 | Crea agente nel piano, rinomina, assegna plugin, ritira | ID stabile, profilo riconoscibile, concessioni distinte, lavori riassegnabili |
| PR-08 | Ora legale, nodo spento, doppio evento, pausa | Politiche dichiarate, run deduplicata, nessuna promessa di esecuzione a nodo spento |
| PR-09 | Ricerca come ospite e come membro | Nessun titolo/snippet non autorizzato; stessa richiesta in inbox e chat |
| AG-05 | Termina processo prima/dopo effetto e prima/dopo commit | Ripresa o esito incerto esplicito; nessuna doppia scrittura automatica |
| AG-07 | Due chiamate con budget residuo insufficiente | Prenotazione atomica; una attende/è negata; consuntivo senza doppio conteggio |
| ME-01–04 | Stesso agente, due clienti con regole opposte | Recupero pertinente, fonte visibile, nessuna contaminazione |
| ME-02–04 | Correggi, elimina, esporta e ricostruisci indice | Nuova versione corretta, dato eliminato non recuperato, portabilità verificata |
| SE-01–03 | Cambia preferenza personale e policy spazio | Ambiti distinguibili; conferma salvataggio reale e conflitti gestiti |
| AU-01–02 | Collaboratore tenta aumento privilegi/revisione altrui | Negato dal motore anche chiamando direttamente API |
| AU-03 | Ispeziona disco/log/checkpoint e traffico modalità locale | Nessuna copia inattesa in chiaro o invio esterno |
| AU-04 | Installa su Mac pulito | Nessun terminale/installazione Python manuale, percorso di errore utile |
| AP-02–05 | Reinvio comando, cursor perso, upload interrotto | Idempotenza, recupero snapshot senza buchi, ripresa file verificata |
| AP-06 | Client TS e client di prova Dart sullo stesso motore | Contratto equivalente, errore incompatibilità comprensibile |
| NE-01 | Due reti distinte, diretto impossibile | Relay se configurato o limite esplicito, nessun falso «connesso» |
| NE-02 | Peer perde rete dopo effetto esterno | Riconciliazione, nessuna delega duplicata cieca |
| NE-03 | Ripristino su nuovo device e revoca del precedente | Recupero valido, vecchio device bloccato alle nuove azioni |

## QA-02 — Criteri non funzionali proposti

- Nessun test di successo sostituisce test negativi di autorizzazione.
- Almeno 30 casi deterministici di dominio e 20 casi AI con fonti/risposte attese prima della beta. Proposta gate AI: almeno 90% piani strutturalmente validi; zero violazioni osservate di policy. Non è garanzia statistica universale.
- Crash/resume ripetuto per ogni confine critico; ricevute esterne verificate in ambiente di prova reale.
- Dataset UX: 100 conversazioni, 50 progetti, 100 file. Target proposto su hardware di riferimento da fissare: letture locali/search testuale p95 entro 500 ms con indice pronto; feedback UI immediato distinto da completamento. Tempi LLM/rete riportati separatamente.
- Nessuna operazione lunga blocca il client senza stato, annullamento dove possibile e request_id.
- Accessibilità: uso da tastiera dei flussi principali, focus corretto nei dialoghi, contrasto e testo ridimensionabile; desktop e mobile senza overflow orizzontale involontario.
- Storage pieno, archivio bloccato, modello assente, rete offline, credenziale scaduta e schema incompatibile sono errori di prodotto progettati.
- Telemetria esterna opt-in; log redatti e retention configurabile. Diagnostica non esporta segreti o documenti per default.
- Backup verificato includendo blob, manifest, memoria, configurazione e meccanismo di recupero. Snapshot JSON del prototipo non è un backup completo del prodotto.

## DEC — Registro decisioni aperte

| ID | Questione | Proposta di partenza | Evidenza per chiudere |
|---|---|---|---|
| D-AUTH-01 | Identità e accesso su app autonome | Identità persona distinta da device; pairing senza account Homun obbligatorio | Prova due utenti/due device, revoca e recupero |
| D-NET-01 | Trasporto/tunnel | Diretto con relay opzionale configurabile; valutare librerie esistenti | LAN, due NAT, relay forzato, packaging |
| D-OWN-01 | Autorità dello spazio | Un nodo per spazio nella v1 | Accettazione del limite di disponibilità e trasferimento autorità |
| D-OFF-01 | Uso offline | Consultazione cache consentita e bozze; nessuna nuova decisione condivisa autorevole | Percorso UX e gestione conflitti |
| D-CRYPTO-01 | Cifratura di database/file/checkpoint | Primitive esistenti, chiavi nel secret store, cifratura dell'intero archivio derivato | Prova driver/package, ispezione disco e review |
| D-KEY-01 | Recupero personale/aziendale | Recupero esplicito scelto dal proprietario; niente accesso amministrativo occulto | Ripristino su device pulito e decisione dati privati |
| ~~D-RUN-01~~ | ~~Pydantic AI + DBOS~~ | **Chiusa 2026-09-17:** stack runtime adottato; hardening in ADR F0.2, non sostituzione | Crash/resume F0.2 PASS; resto = miglioramento in loco |
| D-MEM-01 | Primo backend memoria | File/ricerca e Mem0 dietro unico contratto, confronto limitato | Stessi casi italiano, isolamento, rettifica, export e costo |
| D-MODEL-01 | Modelli e hardware | Un remoto e uno locale, versioni fissate | Qualità strutturata/tool su macchina target |
| D-TOOLS-01 | Connettori del pilot | File, ricerca web, Trello; email dopo | Ricevute e revoca reali, account di prova |
| D-DESK-01 | Packaging | Electron confermato per le versioni installabili; React per la UI e Python per il motore | Installer pulito, gestione processo e aggiornamento |
| D-RET-01 | Retention e cancellazione | Policy separate per messaggi, file, audit, backup e cache | Requisiti aziendali e UX di cancellazione |
| D-LIC-01 | Licenza Homun e dipendenze | Core gratuito; riuso conforme a licenze bloccate | Inventario licenze e scelta del proprietario |
| D-SIZE-01 | Quote e limiti | Limiti espliciti per upload, contesto e concorrenza | Benchmark hardware e costi pilot |

La decisione sulla blockchain non blocca la v1: proposta esclusione. La decisione sul client Flutter completo è successiva; la compatibilità delle API è richiesta da subito.

## REL — Ordine di costruzione

1. Chiudere autorità, accesso e perimetro del pilot; hardenizzare cifratura e packaging sullo stack runtime già adottato (Pydantic AI + DBOS).
2. Dominio persistente e API, collegamento della UI attuale senza rinnovo grafico.
3. Primo lavoro reale, file e contributi, risultato/versioni/revisione; memoria minima sostituibile.
4. Due installazioni, pairing, trasferimenti selettivi e un contributo umano remoto.
5. Primo connettore con effetto reale, autorizzazione e ricevuta; delega a peer.
6. Automazioni, memoria condivisa/formazione, costi e settings completi.
7. Installer, backup, aggiornamento e pilot con 2–5 persone.

Flutter può svilupparsi sul contratto dopo fase 2 senza attendere tutti i connettori. Replica con failover non deve entrare implicitamente nella fase 4.

## REV — Come analizzare la specifica

Ordine consigliato: PR-01–05 (esperienza), AG-01–07 (agenti), ME-01–04 (memoria), SE/AU (controllo), AP/NE (API e rete), infine registro DEC.

Per ogni sezione annotare: accettata, da modificare, esclusa dalla v1; una decisione chiusa registra data, motivo e impatto sul piano. Le proposte diventano vincolanti solo dopo revisione; nessuna implementazione viene avviata da questo documento.

## Evidenza di questa consegna documentale

Specifica ricavata dalla conversazione, dai documenti di architettura e dai tipi/componenti esistenti di profili e settings. Verifica dei collegamenti locali e copertura delle aree richieste. Non sono stati eseguiti test runtime del futuro motore né installate librerie con questa consegna.
