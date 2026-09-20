# Autorizzazione dei lavori e della consegna runtime

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

> Documento storico: identità di sessione, letture, replay risorse e compatibilità
> schema sono stati ulteriormente verificati e corretti nella
> [consegna successiva](2026-09-19-autonomous-foundations-delivery.md).

19 settembre 2026. Continuazione autonoma delle basi di produzione; nessuna
migrazione, credenziale reale, commit o push. La separazione completa degli utenti
non è dichiarata pronta: vedere i confini rimasti aperti.

## Difetti riprodotti e correzioni

Diversi comandi work/plan controllavano soltanto il workspace. Inoltre DomainService
restituiva il risultato memorizzato senza riconsiderare una revoca. Ora
`policy/work.py` verifica AccessGrant prima del gestore e prima del replay, dopo
aver verificato che command_id identifichi ancora la medesima richiesta.

Le conversazioni di progetto richiedono write per creazione, messaggi e creazione
lavori. I lavori richiedono write su tutti i progetti collegati, incluso il progetto
delle conversazioni collegate. Il contributo risolve il lavoro dalla richiesta
persistita, senza fidarsi di un work_id aggiunto dal chiamante. Restano applicati
anche i vincoli di ruolo e stato dei gestori esistenti. Il follow-up modello riusa
lo stesso controllo conversazione. I lavori senza progetto conservano il comportamento
workspace esistente: non sono stati inventati proprietari o concessi nuovi permessi.

La consegna outbox verificava pausa/cancellazione, non i permessi correnti.
`policy/runtime.py` risolve l'attore dal CommandRecord persistito; `runtime/outbox.py`
ricontrolla al claim e subito prima dell'I/O. Per lavori con progetto, provenienza
mancante, revoca o scadenza bloccano l'invio con permission_denied persistito.
Anche il lease scaduto blocca il controllo finale. La concessione successiva di un
permesso valido consente un nuovo tentativo senza ricreare l'intent.

La compatibilità con intent legacy privi di CommandRecord vale solo per lavori senza
alcun progetto collegato. Un lavoro mancante non viene eseguito; un vecchio test
runtime con riferimento orfano è stato aggiornato aggiungendo il lavoro alla fixture.

Moduli nuovi piccoli, nessuna nuova dipendenza e nessuna espansione della shell UI.

## Evidenza

- Prima della correzione: 31 test command-authority falliti e 6 test outbox falliti.
- Suite backend completa: **263 passati, 1 Mem0 live saltato**, 60,39 s, un warning
  Starlette/AnyIO preesistente. Log `/tmp/homun-authorization-tests.log`.
- Dopo la raccolta della suite sono stati aggiunti due casi: revoca sul progetto di
  una conversazione collegata e contributo con work_id estraneo. La suite mirata finale
  autorizzazione registra **42 passati**, inclusi questi due: 265 casi backend distinti
  verificati complessivamente, senza presentare il dato come una singola esecuzione.
- HTTP reale tramite TestClient: 403 permission_denied, nessun comando persistito e
  nessuna modifica del lavoro quando l'attore non ha accesso.
- Outbox: revoca/scadenza/provenienza mancante dopo riapertura del database; revoca
  fra claim e invio; lease scaduto; nuovo claim dopo ripristino del permesso.
- Architettura: zero errori, 30 avvisi di dimensione preesistenti.
- Desktop: **8 test passati**, con il nuovo motore incorporato per i test di lifecycle.
- Smoke congelato aggiornato: il vecchio bundle 08-50 fallisce perché il comando
  vietato viene accettato; il nuovo archivio estratto passa autorizzazione progetto,
  replay negato dopo revoca, avvio/arresto, riavvio durevole e una sola ricevuta.
  PATH=/nonexistent, nessun PYTHONPATH, dati e directory temporanei.
- SHA ZIP/CRC, inventario del motore e corrispondenza dei quattro moduli shell verificati.

## Artefatto

`dist/desktop/2026-09-19T10-10-19-092Z/Homun-0.1.0-macos-arm64.zip`

181707158 byte; SHA-256 `649211b6f06701b05b4f291baeb8e812a70d9f33ea9ed2e8ded90d0ba700b85d`.
Ricevuta engine SHA-256: `946255f4d053db3148975d5bd3281538dd84526530d1a57eac867c3b1468e0ec`.

Candidato locale senza firma Developer ID/notarizzazione. Nessuna nuova prova della
GUI nativa o di installazione su Mac pulito. Sostituisce il candidato 08-50 per questa
correzione; nessuna pubblicazione remota.

## Confini ancora aperti, riscontrati nel codice

- `routes/domain.py`: elenco/dettaglio lavori, run ed eventi non applicano ancora il
  filtro di lettura per attore presente sulle conversazioni e sui progetti. Serve
  adeguare insieme route e client; l'attuale sessione locale non è una separazione
  dei dati per utente.
- `routes/domain_support.py`: l'attore è ricavato da X-Homun-Actor-Id; il middleware
  autentica il token della sessione, non lega quell'header a un'identità autorizzata.
  Questo lavoro non trasforma il motore in un servizio multiutente sicuro.
- Replay dei comandi project/material/grant: rimane fuori dalla policy dei lavori.
- Una revoca può ancora arrivare dopo l'ultimo controllo e dopo l'accettazione I/O.
  Il blocco pre-invio non annulla effetti già iniziati da DBOS o sistemi esterni.
  Non è stata implementata una nuova procedura di revoca degli effetti in esecuzione.
- Aggiornamenti/rollback schema, firma e Keychain restano tranche distinte.
