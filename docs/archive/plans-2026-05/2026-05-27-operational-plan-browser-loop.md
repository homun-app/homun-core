# Operational Plan Browser Loop

## Goal

Portare il percorso operativo verso il modello funzionante di Homun, ma in forma
piu' semplice: prima un piano verificabile, poi un loop browser continuo che
avanza gli step e chiude il task solo quando i criteri di successo sono veri.

## Decisioni

- Il primo contratto e' `OperationalPlan` nel Desktop Gateway.
- Il piano viene salvato in `TaskRecord.input_json` e nei checkpoint redatti.
- Il browser task non puo' dichiararsi completato solo perche' ha aperto fonti,
  compilato campi o cliccato Cerca.
- Per il caso treno il criterio minimo e': almeno una opzione leggibile con
  orario e operatore/tratta.
- Se il criterio non e' soddisfatto, il task va in `waiting_external_event` e
  la chat deve spiegare che la ricerca non e' conclusa.

## Implementato

- Piano treno con step:
  - comprendere richiesta;
  - aprire fonti;
  - compilare form;
  - cercare opzioni;
  - estrarre risultati;
  - rispondere e chiedere la scelta.
- Approval iniziale con riepilogo piano e gate.
- Checkpoint con `operational_plan`, `success_criteria_met` e
  `blocked_reason`.
- Risposta finale piu' onesta: "Ricerca treni non conclusa" quando non ci sono
  opzioni estratte.
- Test unitari sul contratto del piano e sui criteri di successo.

## Prossimi Step

- Spostare `OperationalPlan` fuori da `main.rs` in un modulo dedicato.
- Collegare il planner Brain locale alla generazione del piano.
- Portare nel browser loop le policy Homun-style:
  - form plan da snapshot;
  - autocomplete selection;
  - retry/strategy rotation;
  - result extractor per schema dati;
  - blocker espliciti per captcha/login/submit/pagamento.
- Aggiungere fixture locale e test end-to-end per prenotazione treno simulata.

