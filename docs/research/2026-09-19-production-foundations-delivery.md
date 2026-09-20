# Fondamenta Homun: consegna del 19 settembre 2026

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

Tranche eseguita in autonomia dopo l'approvazione della proposta. **Il motore è stato consolidato; Homun non è ancora pronto alla distribuzione in produzione.** Il confronto con Hermes ha informato i confini, senza sostituire Pydantic AI/DBOS o importare il suo orchestratore.

## Modifiche effettive

| Prima | Adesso | Evidenza principale |
|---|---|---|
| Riutilizzo di `command_id` anche con payload o attore diversi | Fingerprint versionato di workspace, attore, tipo e JSON canonico; replay solo identico | `test_command_identity.py`, incluso riavvio SQLite |
| Salvataggio con cancellazione e reinserimento di tutte le righe | Delta, transazione, rollback, lettura coerente e generazione contro aggiornamenti obsoleti | 16 regressioni storage, doppio handle, fallimento anche al commit |
| `DomainService` di 1.712 righe | Facciata di 188 righe; 12 moduli funzionali da 64–216 righe più contesto condiviso | Suite dominio esistente e controllo dipendenze |
| Route dominio di 718 righe, interpretazione nel trasporto | Route di 335 righe; materiali e supporto HTTP separati; use case applicativo comune | HTTP e SSE passano dallo stesso ingresso transazionale |
| Modello chiamato prima del commit del messaggio | Messaggio e claim persistiti prima del modello; finalizzazione separata, con token che invalida tentativi superati | Errore provider, retry senza duplicati, scritture concorrenti, lease scaduta |
| Streaming poteva perdere la risposta alla disconnessione | Nessuna sospensione fra claim e completamento; risposta salvata prima dei token di presentazione | Chiusura del generatore al primo evento `persisted` |
| Avvio/invio DBOS prima del salvataggio del comando | Intenzioni persistite nella stessa transazione, consegna successiva con ID stabili e deduplica | Rollback, retry, deduplica DBOS e recovery in due processi |
| Attesa sincrona bloccava l'uscita Python | Workflow asincrono su coda DBOS, loop posseduto dal runtime e chiusura coordinata | Processo realmente terminato e riavviato con workflow pendente |
| Consegna pendente anche dopo annullamento | Claim transazionale, lease e verifica di annullamento/pausa; ordine per run | Annullamento prima del claim, durante invio, isolamento tra lavori |
| Memoria e dominio committavano la stessa connessione | Connessione dedicata alla memoria, scritture serializzate e transazionali | Scrittura memoria durante interpretazione senza interferire col dominio |
| Import poteva accettare percorsi fuori archivio | Manifest v1 con un solo database atteso; rifiuto di traversal, symlink e inventari ambigui; contenimento dei blob | `test_storage_paths.py` |
| Versioni Python risolte liberamente | Lock con hash, installazione solo wheel e build editable senza download di dipendenze | Ambiente nuovo, versioni preesistenti mantenute, controllo metadati |
| Regola «no monoliti» solo descrittiva | Controlli su cicli, dipendenze vietate, dimensioni e budget legacy decrescenti; CI backend/frontend | 15 test del checker; nessun errore architetturale |

Gli errori `command_in_progress`, `storage_unavailable` e `provider_unavailable` restano distinti anche nel client. La capability runtime dipende dall'avvio effettivo; un errore di startup DBOS interrompe l'avvio invece di nascondersi dietro capability positive.

## Contratti operativi

- Un comando riuscito salva insieme entità, eventi, risultato e intenzioni runtime. Un errore prima del commit non pubblica mutazioni nella cache condivisa.
- Un salvataggio senza modifiche non scrive righe e non cambia generazione. Due snapshot non possono sovrascriversi silenziosamente.
- I vecchi record senza fingerprint rimangono leggibili, ma il replay non verificabile restituisce conflitto: non viene inventata l'identità originale della richiesta.
- Il modello non opera dentro una transazione SQLite. Un retry con lo stesso comando riprende il follow-up fallito senza aggiungere un secondo messaggio utente. Un tentativo sostituito non può salvare un secondo risultato.
- La lease del follow-up modello dura cinque minuti. Dopo un crash serve il retry della stessa richiesta alla scadenza: **non è ancora un recupero automatico delle interpretazioni**. Una chiamata modello può essere ripetuta; il risultato dominio è protetto contro duplicati.
- L'outbox runtime viene riletta all'avvio e periodicamente. Consegna almeno una volta, deduplica tramite workflow ID e chiave del messaggio DBOS; conferme protette dal token della lease. Nessuna promessa generale di “exactly once” verso servizi esterni.
- Annullare prima del claim impedisce l'invio. Dopo l'autorizzazione alla consegna, un contributo può essere già in volo: l'esito diventa `cancellation_uncertain`, poi viene riconciliato. Non si presenta come fermata certa un'azione che potrebbe essere già avvenuta.
- Gli eventi SSE sono presentazione della risposta completata. Non sono token live del modello; `persisted` viene emesso dopo il completamento per non lasciare claim sospesi alla disconnessione.

## Verifiche

| Verifica finale | Risultato |
|---|---|
| Suite backend nel virtualenv esistente | **181 passati, 1 saltato**, 43,95 s; uscita normale |
| Suite backend in ambiente nuovo, wheel e hash del lock | **181 passati, 1 saltato**, 54,43 s; exit 0, nessun processo residuo nel gruppo di test |
| `npm run check` | **120 test passati**, TypeScript e build app/prototipo riusciti |
| `npm run architecture:check` | **0 errori**, 30 segnalazioni dimensionali legacy congelate |
| Motore HTTP reale su loopback | Creazione e risposta persistite; arresto, riavvio, replay identico e richiesta modificata rifiutata |
| Runtime DBOS in due processi | Workflow pendente ripreso, messaggio deduplicato, effetto/ricevuta riconciliati, arresto pulito |
| Review indipendenti | Controllo perimetro e correttezza; corretti difetti SSE e consegna dopo annullamento; nessun P1 residuo rilevato nel controllo mirato |
| `git diff --check` | Nessun errore |

Il test saltato richiede lo stack Mem0 live. Rimane un avviso di deprecazione Starlette/AnyIO; le build segnalano chunk legacy grandi. Python verificato 3.13.12; Node locale 25.9.0. CI configurata per Python 3.13.12 e Node 24, ma **non eseguita su GitHub** in questa tranche.

Sono prove su dati sintetici e provider fake, salvo l'esecuzione reale del runtime DBOS e del trasporto HTTP locale. Nessuna prova con credenziali/provider a pagamento e nessuna accettazione visuale desktop sono implicate.

## Limiti aperti e ordine successivo

1. **Confine di fiducia locale:** sessione attendibile fra shell e motore; autorizzazione uniforme su letture, replay e revoche. Gli header attuali non sono autenticazione forte.
2. **Dati e distribuzione:** verificare profilo DBOS locale, driver cifrato, segreti OS e recupero chiavi nello stesso pacchetto desktop; installer/firma/upgrade ancora assenti. Vedi [requisiti di release](2026-09-19-production-release-gates.md).
3. **Materiali e backup:** l'ingestione scrive ancora il blob prima del CAS. Il conflitto è esplicito ma può lasciare un blob orfano. Servono staging/finalizzazione, identità stabile e raccolta degli orfani. Backup v1 salva soltanto SQLite workspace, non originali, checkpoint DBOS e ricevute: non è il ripristino completo dell'installazione.
4. **Esecuzione reale:** registro strumenti, policy, budget riservati, contesto separato dalla trascrizione, turni agentici e valutazioni. La ricevuta DBOS provata è dimostrativa.
5. **Dimensioni e scalabilità:** le scritture sono incrementali ma lettura e confronto caricano ancora il workspace intero. Restano 30 file frontend/prototipo sopra 500 righe, con budget congelati; non sono stati dichiarati risolti. Persistono due eccezioni esplicite per I/O materiali nel dominio.
6. Memoria governata completa e multi-device restano nelle fasi successive della proposta, senza nuovo orchestratore parallelo.

## Conservazione del lavoro

Branch locale `fabio/production-foundations`. Prima delle modifiche è stato archiviato il workspace, inclusi file non tracciati ma esclusi quelli ignorati da Git, in `/Users/fabio/.codex/backups/homun2-foundations-20260919-090746`. Il progetto conteneva già molte modifiche non committate: sono state preservate. Nessun commit, push o riscrittura della cronologia Lovable in questa tranche.
