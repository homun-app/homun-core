# Ingestione ODT nella chat

## Problema

Un file ODT allegato viene persistito, ma il gateway non ne estrae il testo. Il fallimento
viene degradato a una nota `⚠️` e il manifest del prompt lo dichiara comunque `text`; il
modello riceve quindi un errore presentato come contenuto pronto e può soltanto chiedere una
conversione.

## Approcci considerati

1. **Estrazione nativa dal pacchetto ODT — scelta.** L'ODT è uno ZIP standard: il gateway
   legge `content.xml`, mantiene paragrafi, titoli, celle, tab e interruzioni di riga e decodifica
   le entità XML. Riusa la dipendenza `zip` già canonica per PowerPoint, resta locale e non
   dipende dall'installazione di LibreOffice.
2. **Conversione con LibreOffice.** Copre più varianti visive ma aggiunge un processo esterno,
   disponibilità non uniforme e maggior latenza per un riepilogo che richiede solo testo.
3. **Fallback affidato al modello.** È fragile, consuma contesto e contraddice il principio che
   lo stato e il controllo deterministico appartengono all'harness.

## Disegno approvato

- `attachments.rs` riconosce estensione `.odt` e MIME OpenDocument Text prima del ramo
  `text-like`.
- L'estrattore apre il pacchetto con i limiti esistenti, richiede `content.xml`, considera solo
  il corpo del documento e produce testo leggibile senza interpretare stili o macro.
- Un documento valido ma privo di testo restituisce un errore esplicito; un ZIP corrotto o senza
  `content.xml` degrada senza panic come gli altri allegati.
- Il prompt distingue `text`, `images/scan` e `unavailable`. Le note di errore finiscono in una
  sezione diagnostica separata e non sotto `Attachment content`.
- Non vengono introdotte keyword sull'intento, un secondo store o un percorso alternativo di
  memoria.

## Verifica

- Test unitari costruiscono ODT reali in memoria e coprono MIME, estensione, paragrafi, titoli,
  spazi ripetuti, tab, interruzioni, tabelle, entità XML, pacchetto corrotto e `content.xml`
  mancante.
- Un test del prompt blocca la regressione per cui `⚠️` veniva dichiarato `text`.
- Gate finale: test mirati, intero crate gateway, formattazione, build desktop e prova con
  `chat_2026-07-20.odt`.

## Confini

Questa slice corregge l'ingestione e la rappresentazione dell'allegato che hanno causato la
chat osservata. La classificazione generale `goal_satisfied` e la riduzione del prompt globale
restano contratti dell'agent loop e non vengono accoppiati al parser ODT.
