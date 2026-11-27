# La memoria: dove sta, la copia prima di un aggiornamento, come tornare indietro

La memoria dei bot — ciò che ricordano fra i turni e la cronologia indicizzata
delle conversazioni — vive in un motore chiamato Engramma, dentro il demone
di Homun (`ARCHITETTURA.md` dice dove sta ogni cosa). Questa guida serve
quando cambia il formato delle celle, cioè quando una versione di Homun porta
un motore più nuovo, e si vuole poter tornare indietro.

## Dove stanno le celle

Tutto sta nella cartella dei dati, `~/Library/Application Support/sandbot/data/`:

| Cartella | Che cos'è |
|---|---|
| `memory/` | la memoria del motore. Dentro, `cells/` con le celle: `bot-<id>.sqlite` (le memorie di un bot), `storia-<id>.sqlite` (le sue conversazioni indicizzate), `utente.sqlite` (le memorie condivise da tutti i bot). Accanto a un `.sqlite` possono esserci `-wal` e `-shm`: fanno parte della cella, non si toccano né si cancellano a mano. |
| `memory-backup-schema<Numero>-<data>` | la copia di `memory/` fatta da Homun prima che un motore nuovo aggiornasse le celle (qui sotto). Ha gli stessi file di `memory/`. |
| `memory-migrata-<data>` | la memoria aggiornata, messa da parte da un ripristino (qui sotto). |
| `memory-legacy-<data>` | i vecchi file della memoria (fase 4), spostati qui quando sono diventati note del motore: una copia di sicurezza. |

## La copia prima che il motore aggiorni le celle

Quando una versione di Homun porta un motore che cambia il formato delle celle
(per esempio dalla v0.4.3 alla v0.6.19 di Engramma: dallo schema 12 al 24),
succede questo:

1. la prima volta che apre la memoria, Homun **prima** copia l'intera cartella
   `memory/` in `memory-backup-schema<Numero>-<data>` accanto a lei (per
   esempio `memory-backup-schema12-2026-11-27`): `<Numero>` è lo schema delle
   celle in quel momento, `<data>` il giorno della copia;
2. **poi** apre il motore, che aggiorna le celle una alla volta, quando le usa.

L'aggiornamento **non torna indietro**: la copia è l'unico modo per ritrovare
le celle com'erano.

- **Si fa una volta sola.** Ai boot seguenti Homun non la rifà, finché le
  celle restano com'erano nella copia. Se una cella cambia prima di essere
  aggiornata, ne fa un'altra accanto (con `-2` nel nome) e non tocca quella
  fatta.
- **Senza spazio non aggiorna nulla.** La copia vuole la dimensione di
  `memory/` più 5 GB liberi. Se non ci sono, la memoria risulta non
  disponibile («Serve spazio sul disco per aggiornare la memoria in sicurezza:
  liberane N GB») e il resto di Homun funziona. Liberato lo spazio, al boot
  dopo la copia si fa da sé e la memoria torna.
- **Non si cancella da sola.** La copia si può cancellare a mano solo quando
  si è sicuri di non dover tornare indietro.

## Tornare indietro: il ripristino

Serve quando si torna a una versione precedente di Homun dopo che le celle
sono state aggiornate. **Non aprirla prima sulle celle aggiornate**: un Homun
precedente non conosce il formato nuovo e le rovina. Prima si rimette la
copia.

Le note scritte dopo l'aggiornamento non sono nella copia: restano nella
cartella `memory-migrata-<data>`, che per questo non si cancella.

Tutto **con Homun chiuso**, in questo ordine:

1. **Esci da Homun**: dall'icona nella barra dei menu, voce «Esci». Chiude
   anche il demone: in Attività non deve restare nessun processo di Homun. Se
   serve, installa di nuovo la versione precedente, senza aprirla.
2. Apri la cartella dei dati: in Finder, Vai › Vai alla cartella… (⇧⌘G) e
   scrivi `~/Library/Application Support/sandbot/data`.
3. Sposta da parte la memoria aggiornata: rinomina la cartella `memory` in
   `memory-migrata-<data di oggi>` (per esempio `memory-migrata-2026-11-28`).
4. Rimetti la copia: duplica la cartella `memory-backup-schema<Numero>-<data>`
   (Comando D) e nomina la copia `memory`. La copia di sicurezza resta dov'è.
5. Apri la versione precedente di Homun: ritrova le memorie com'erano al
   momento dell'aggiornamento.

Per tornare avanti di nuovo, alla versione nuova: esci da Homun, rinomina
`memory` in `memory-ripristinata-<data>` e `memory-migrata-<data>` di nuovo in
`memory`. Le note scritte con la versione precedente dopo il ripristino restano
in `memory-ripristinata-<data>`.
