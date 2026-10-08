# Recupero durevole dai guasti del provider — 23 settembre 2026

Prima tranche H06 della [matrice Hermes](2026-09-23-hermes-parity-matrix.md):
i guasti temporanei del modello diventano attese persistenti e visibili, non
fallback silenziosi né loop di ritentativi nel trasporto HTTP. Non è parità
completa di H06: vedi «Limiti aperti».

## Implementazione e provenienza

La tassonomia degli errori e il backoff derivano da `agent/error_classifier.py`,
`agent/retry_utils.py` e `agent/turn_recovery.py` (compute_error_backoff) del
riferimento Hermes `c9dca726514b709cf6e677d236a79fc8d0627f37`; la collocazione
dei ritentativi (tre tentativi totali per fase, attese fuori da lease e
transazioni, correzioni che sopravvivono al backoff) deriva da
`agent/turn_api_error.py`. Attribuzione e licenza MIT in
`engine/src/homun/notices/hermes-agent.txt`. Nessuna dipendenza runtime Hermes.

- `models/native_errors.py`: `NativeModelError` tipizzata e sanitizzata (codici
  `agent_model_network/timeout/rate_limited/server_error/auth/quota/
  invalid_request/tls/overflow/empty_response/truncated/malformed`),
  Retry-After numerico/data con tetto 600 secondi, testi di reset analizzati ma
  mai conservati, messaggi ridotti a una riga e troncati. Corpi grezzi dei
  provider non vengono persistiti: solo codice, fase, contatore e tempi.
- `models/native_transport.py`: i consumi dichiarati dal provider sono estratti
  **prima** della validazione della risposta; un rifiuto o un troncamento
  addebita comunque i token reali. Metadati di usage malformati non invalidano
  più una risposta valida: restano unknown. Il trasporto non ritenta: espone
  solo fallimenti tipizzati.
- `application/agent_recovery.py`: attesa persistente per fase (`decide` e
  `summary` separate), tre tentativi totali, contatori salvati nel run prima
  dell'IO e mai azzerati da riavvio o replay DBOS; backoff base2 con jitter
  (base 2 s, tetto 60 s) oppure Retry-After (tetto 600 s). Nessun lease o
  transazione trattenuta durante l'attesa: il workflow ripassa dal proprio
  percorso busy e prima di ogni tentativo rivalida autorità, epoch, lease e
  nuove istruzioni. La fase accettata azzera solo il proprio contatore.
- `application/agent_run_failures.py`: il fallimento terminale condivide la
  recinzione delle correzioni umane già usata dai risultati; una correzione
  arrivata durante l'ultimo tentativo defersce l'esito e riparte con budget
  fresco, come il redirect Hermes che sopravvive al backoff.
- Controlli (pausa/annullo/redirect) interrompono un'attesa pendente e la nuova
  generazione riparte da contatore zero; la consegra superata durante la
  chiamata fallita non scrive nulla. `RunView` espone `recovery` (fase, stato,
  tentativi, prossimo tentativo) nell'API.

Non vengono mai ri-eseguiti strumenti già committati né eseguite chiamate
troncate; testo parziale e checkpoint incompleti non sono pubblicati come
risultati. La risposta troncata è oggi un fallimento tipizzato esplicito, non
una continuazione.

## Verifiche automatiche

- Suite completa: **701 passati, 1 saltato** (baseline 688+1; +13 test recovery,
  di cui 7 scritti a priori come specifica e 6 aggiunti con la prova reale).
- Due test preesistenti aggiornati alla semantica della tranche, con motivazione:
  la busta malformata ora esaurisce tre tentativi durevoli e fallisce con
  `agent_model_malformed` (prima: fallimento immediato `agent_run_invalid_decision`);
  i metadati di usage malformati ora mantengono la chiamata con consumo unknown
  (prima: intera chiamata scartata). Il riepilogo che chiede strumenti, è vuoto
  o troncato addebita i token reali con stato `error`.
- `test_agent_recovery.py`: attesa e riuscita, esaurimento esatto in tre
  tentativi attraverso il riavvio del contesto di processo, troncamento con
  consumi noti e nessuna esecuzione, pausa/annullo/redirect durante l'attesa,
  strumento committato mai ripetuto, fase summary ritentata con contatori
  separati, recinzione durante la chiamata fallente.
- Fixture HTTP locale: 429 con Retry-After numerico, data HTTP e valore oltre il
  tetto; 429 `insufficient_quota` classificato billing; 503; 401; 400 da
  context overflow; risposta 200 tronca con usage preservata.
- Typecheck frontend passato; OpenAPI rigenerato (solo il campo opzionale
  `recovery` in `RunView`); architettura: **0 errori**, 35 avvisi preesistenti.

## Prova reale Ollama

[Esecutore riproducibile](evidence/2026-09-23-hermes-parity/recovery_ollama.py),
[traccia](evidence/2026-09-23-hermes-parity/recovery_ollama.json).

Scenario A — rifiuto di connessione reale e ritentativo reale: la prima chiamata
del run punta a una porta locale chiusa (connection refused autentico). Il run
resta `running` con `recovery` in attesa (fase `decide`, tentativo 1,
`agent_model_network`), nessun lease trattenuto, attesa ~2,1 s (base2+jitter).
Un avanzamento durante l'attesa restituisce `busy`. Riportato il provider su
Ollama `qwen3.5:4b` reale e fatta scadere l'attesa: il modello esegue una vera
lettura del materiale e completa l'artifact con la data di consegna corretta.
Budget onesto: 2 tentativi spesi con token reali (1980 input / 85 output) e
1 tentativo unknown per la chiamata rifiutata. `model_attempts` 3, turni 2,
strumenti mai ripetuti.

Scenario B — 404 reale: modello inesistente su Ollama → HTTP 404 autentico
classificato `agent_model_invalid_request`, non ritentabile: fallimento
immediato e visibile, lavoro failed, nessun recovery schedulato.

## Limiti aperti (resto di H06 e oltre)

- Refresh/rotazione credenziali e provider fallback (catene `auth`, `billing`,
  overload dedicato) non implementati: oggi 401/402/403/404 sono fallimenti
  permanenti tipizzati.
- Continuazione dei troncamenti e riduzione dei payload restano aperte.
  Il successivo [recupero da overflow](2026-09-23-agent-overflow-verifica.md)
  aggiunge compattazione forzata limitata, senza ampliare l'output.
- Ripetitività (repetition guard), liveness/watchdog del turno e disattivazione
  dello streaming su frame vuoti restano da portare.
- L'aumento dell'uso dei tentativi è limitato da `max_model_attempts` del run:
  tre per fase di recovery, il tetto globale resta 12.
- Lo stato di recupero è ora reso anche nel pannello di controllo del lavoro;
  l'app installata e il remoto non sono aggiornati.


## Rafforzamento dopo interruzione del processo

La prima tranche contava i fallimenti dopo la risposta: un arresto durante IO
consumava il budget globale ma non lo slot di recovery. Ora il contatore per fase
è persistito prima della chiamata. Tre arresti simulati con ricreazione del
contesto non consentono una quarta chiamata, sia per decisione sia per riepilogo.

Lo steering interrompe subito l'attesa e una risposta fallita del turno precedente
non la ripristina. Rimane un marcatore del nuovo formato anche dopo i controlli:
una correzione seguita da crash non viene scambiata per uno stato legacy.
La migrazione legge il lease scaduto prima di sostituirlo; quando manca l'identità
della fase usa conservativamente il contatore globale, senza presumere che una
richiesta senza risultato non sia mai partita. Può quindi esaurire prima il limite
per un vecchio stato ambiguo, ma non concede chiamate aggiuntive non dimostrate.

Metadati di consumo negativi, frazionari, non finiti, booleani o testuali diventano
sconosciuti; gli altri contatori validi della stessa risposta restano disponibili.
La UI del lavoro mostra l'attesa e il prossimo tentativo con pausa/correzione/stop.
Typecheck, 216 test web e build web passati; resta l'avviso sui chunk oltre500kB.
I test di crash sono simulazioni controllate, non un nuovo test live del provider.

Suite completa: 718 passati e 1 saltato prima dell'ultimo marcatore di migrazione;
verifica finale mirata dopo la correzione: 62 passati. Revisione indipendente
conclusa senza rilievi residui sulla modifica. OpenAPI allineato e architettura
0 errori / 35 avvisi preesistenti.
