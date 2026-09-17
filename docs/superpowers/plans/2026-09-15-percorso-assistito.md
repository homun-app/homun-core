# Percorso assistito — iterazione UX 2

Direzione autorizzata da Fabio dopo la valutazione UX 02: procedere e riprovare.

## Modifica circoscritta

Sostituire il modulo in tre pagine con bisogno → proposta → squadra/prima prova.
Mantenere i bot agnostici e il core senza chiamate AI o servizi esterni.

- [x] Definire tre esempi dichiarati (preventivi, rassegna, manutenzione), con
  responsabilità, metodo, frequenza, materiali e risultato dimostrativo.
- [x] Separare l'esempio scelto esplicitamente dalla richiesta libera: nessuna
  interpretazione automatica finta. La richiesta libera resta personalizzabile.
- [x] Proposta compatta con nome, metodo e risultato già presenti. Impostazioni
  AI e autonomia su richiesta; riepilogo budget sempre leggibile.
- [x] Dopo accettazione, mostrare collaboratore e lavoro nello stesso spazio,
  con richiesta concreta di materiali e azione per avviare una prova simulata.
- [x] Una prova guidata usa solo i materiali di esempio mostrati; una modifica
  ai materiali impedisce di presentare il risultato precompilato come elaborato.
- [x] Consentire revisione del risultato, chiusura della prova, ritorno al metodo
  e nuova prova. Frequenza visibile; nessuna routine viene attivata realmente.
- [x] Verificare test di stato, tipi/build, desktop/mobile e frizione del percorso.

## File

- `src/lib/assisted-work.ts`: esempi, dati del percorso e transizioni verificabili.
- `tests/assisted-work.test.ts`: isolamento esempi/libero e stati della prova.
- `src/components/builder/FirstWorkJourney.tsx`: coordinamento del percorso.
- `src/components/builder/WorkProposal.tsx`: proposta e dettagli modificabili.
- `src/components/builder/FirstWorkSpace.tsx`: squadra, materiali e prova.

Sessione con schema v2 separato dalla bozza precedente. Riutilizzo dei campi
esistenti solo nelle impostazioni facoltative. Nessuna modifica a DB o motore.

Esito e limiti della seconda prova: `docs/ux/03-valutazione-percorso-assistito.md`.
