# Steering e stato turno compatti

## Contesto osservato

Il collaudo della app installata `v0.1.1077` ha riprodotto il problema mostrato negli screenshot:

- lo stesso `ActiveTurnStatus` viene montato sotto il messaggio assistant attivo e sopra il composer;
- finche non arriva testo visibile resta montato anche `AssistantThinkingState` nel transcript;
- il titolo e la fase del turno possono ripetere la stessa frase (`Homun is still working`);
- il pulsante Attivita usa la chiave inesistente `chat.inspector.activity`, visibile letteralmente;
- ogni steer pendente e una scheda verticale con header, testo e footer, quindi occupa troppo spazio e
  separa visivamente l'istruzione dal composer a cui appartiene.

Il broker e la persistenza sono corretti: uno steer pendente non entra nel transcript e, una volta
applicato, diventa un normale messaggio utente. Questo intervento non cambia tali semantiche.

## Obiettivo

Rendere il lavoro in corso e gli steer leggibili come un'unica zona di controllo sopra il composer:
una sola indicazione del turno attivo e una riga compatta per ogni istruzione in coda. Il transcript
resta dedicato ai messaggi effettivi e alle risposte, mentre Island/Inspector conserva il dettaglio
operativo.

## Disegno approvato

### Stato del turno

- `ActiveTurnStatus` viene montato una sola volta, nella `composer-stack`.
- La variante `assistant-footer` viene ritirata.
- Durante un turno attivo il placeholder assistant vuoto non mostra un secondo thinking state nel
  transcript. Quando arriva testo reale, la risposta appare normalmente.
- La barra diventa una pill compatta: punto teal, fase corrente, tempo, eventuale tentativo solo se
  maggiore di uno, accesso all'Attivita con conteggio e stop.
- Il testo visibile non ripete `stillWorking`; la frase rimane nell'etichetta accessibile.
- La chiave corretta per Attivita e `chat.inspector.views.activity`.

### Steer in coda

- Ogni record non in modifica e una strip orizzontale arrotondata, non una card verticale.
- La strip mostra icona di instradamento, prompt su una riga con ellissi, stato `Richiesta` e posizione.
- Modifica, eliminazione e invio immediato sono icon button con tooltip ed etichette accessibili.
- La modifica espande localmente la strip con la textarea esistente; errori e revision conflict restano
  governati da `ChatView`.
- Piu steer formano una pila compatta e scrollabile. Allegati presenti restano visibili su una seconda
  riga ridotta.

## Confini

Non vengono modificati endpoint, schema SQLite, claim FIFO, replay, cancellazione, attenzione sidebar,
Island o semantica di promozione dello steer. Non viene introdotto un nuovo menu o un secondo modello
di stato.

## Verifica

1. Contratto sorgente rosso/verde: un solo mount di `ActiveTurnStatus`, nessuna variante
   `assistant-footer`, chiave i18n corretta e classi della strip compatta.
2. Test desktop esistenti, typecheck, build e pre-release gate.
3. Build pacchettizzata con profilo di test reale.
4. Test Electron installato: avvio di un turno abbastanza lungo, invio rapido di uno steer, controllo
   DOM e screenshot a larghezza ampia e compatta.
5. Requisiti live: un solo stato attivo, zero stato duplicato nel transcript, una sola strip steer,
   prompt non duplicato, chiavi i18n non esposte e selezione chat invariata.
