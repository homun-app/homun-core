# Rifiuto onesto dei risultati non eseguibili — 22 settembre 2026

> Risposta alla segnalazione «funziona sempre tutto molto male». Diagnosi sul
> profilo reale (in sola lettura), correzione del prompt di sintesi dell'intake
> e verifica col modello reale. Nessun dato reale modificato.

## Diagnosi (profilo reale, sola lettura)

La causa principale non era un bug nuovo ma un difetto di onestà di prodotto,
aggravato da polvere di test:

1. **Richieste fuori perimetro forzate su capacità inadatte.** Alle 21:51 del
   21/9 Fabio ha chiesto «Prepara il catalogo prodotti per il cliente Acme»
   nel lavoro «Catalogo»; alle 05:40 del 22/9 il motore ha consegnato
   «Confronto completato: 0 aumenti, 4 diminuzioni…». Il registro ha due sole
   capacità eseguibili (`compare_csv`, `read_material`): un catalogo non è
   fra queste, ma il prompt di sintesi spingeva il modello a scegliere
   l'eseguibile più vicino. Il risultato sembra «tutto rotto» perché non
   c'entra nulla con la richiesta.
2. **Tentativi falliti che si accumulano.** Ieri tra le 13:47 e le 13:48 tre
   bozze «catalogo» in due minuti (i tentativi non riusciti non si puliscono
   da soli); un tentativo del 21/9 mattina era finito nel percorso chat con
   la risposta in formato interpretazione.
3. **Polvere di test nel profilo reale.** Lavori del 17-18 settembre con
   obiettivo letterale «obj» e conversazioni «Smoke2», «Auto test», «Fake
   OK»: la sidebar mostra sedici bozze, la maggior parte spazzatura.
4. Un lavoro sano esiste: «Rinnovo contratto cancelleria», accordo confermato
   in attesa dei materiali.

## Correzione

Il prompt di sintesi dell'intake (`engine/src/homun/prompts/intake/synthesize.{it,en}.txt`)
ora contiene la regola del rifiuto onesto: se il risultato chiesto non è fra
le attività eseguibili elencate (creare un catalogo, scrivere un documento
nuovo, avviare un processo), la capability è `general`, il lavoro resta di
preparazione e il rationale dichiara cosa Homun sa fare concretamente oggi
(confronto fra due CSV, lettura di un documento) e cosa servirebbe per il
risultato completo. Vietato forzare il risultato in un'attività inadatta:
una richiesta di catalogo non diventa un confronto listini.

## Prove realmente eseguite

- **Modello reale** (glm-5.3-flash:cloud via Ollama, profilo usa-e-getta,
  motore 8768): «Prepara il catalogo prodotti per il cliente Acme entro
  venerdì» → `capability: general`, rationale: «Creare un catalogo prodotti
  non è tra le attività che Homun può eseguire automaticamente oggi: sa
  confrontare due file CSV… e leggere il contenuto di un documento… Per
  arrivare al catalogo completo servirebbe la possibilità di generare il
  documento finale, che oggi non è disponibile».
- **Percorso positivo invariato**: «Confronta i listini prezzi di marzo e
  giugno…» → `capability: compare_csv`, collaboratore proposto (Elena).
- **Suite motore**: 454 superati, 1 saltato.

## Limiti e decisioni aperte

- Il rifiuto onesto dichiara il limite, non lo risolve: se il bisogno reale
  è produrre cataloghi, serve una capability di generazione documento —
  decisione di prodotto che appartiene al disegno del piano multi-fase
  (un catalogo = raccolta → lettura → confronto → generazione).
- La pulizia del profilo reale (archiviare le bozze morte e i resti di test)
  tocca dati reali: richiede il via esplicito di Fabio; l'archiviazione è
  reversibile.
- Il motore reale su 8765 va riavviato per caricare i prompt aggiornati
  (i file di prompt sono input di runtime del processo).
