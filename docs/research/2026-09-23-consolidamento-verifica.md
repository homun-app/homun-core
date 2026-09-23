# Consolidamento verificato — 23 settembre 2026

Base `e5155baf`, sorgente `0.2.1001`, branch `fabio/consolidamento-2026-09-23`.
Worktree: `/Users/fabio/.codex/worktrees/homun-consolidamento/homun2`.
Le correzioni seguono la [rianalisi](2026-09-23-rianalisi-progetto.md) e la
prosecuzione approvata da Fabio. Nessuna release pubblicata o installata.

## Risultato

1. **Materiali e Plugin:** gli ingressi laterali del percorso motore leggono e
   modificano dati reali; upload e archiviazione riusano le operazioni comuni.
   Il catalogo MCP è lo stesso delle impostazioni. Eliminati testo obsoleto e
   conteggio Plugin derivato dalla simulazione. Un rifiuto di accesso durante
   upload/archiviazione rimuove elenco e anteprima già aperti.
2. **Catene:** recupero della continuazione dopo la pubblicazione dell'artifact,
   senza duplicare risultati né riattivare lavori modificati o cancellati.
   I passi completati attraversano ancora il runner decorato, preservando
   l'ordine delle chiamate nel journal DBOS durante il replay.
3. **Sintesi e budget:** approvazione umana separata dall'assegnatario cui viene
   attribuito il consumo. Cap globali e individuali esauriti impediscono nuove
   chiamate anche quando la stima token è zero. Se il provider dichiara solo
   uno dei due conteggi, i token noti sono spesi e il tentativo è incerto una
   volta sola, anche nell'allocazione. Riserva chiusa senza perdere consumi.
4. **Fonti della sintesi:** binding dei materiali (identità, titolo, versione,
   hash) e revisione/approvazione delle procedure verificati all'approvazione,
   all'esecuzione e prima della pubblicazione. Nessun artifact su fonti invalidate.
5. **Routine:** riconciliazione di esistenza, cron, fuso e pausa dello schedule.
6. **Scadenze:** Compiti usa lo stesso comando persistente della conversazione;
   attesa visibile, controllo disabilitato durante il salvataggio, errori tipizzati.
7. **Updater:** il solo evento `update-available` offre il dialogo; la chiamata
   manuale non lo ripete. I test specifici sono inclusi anche nella CI.

## Verifiche eseguite

| Controllo | Esito | Confine della prova |
| --- | --- | --- |
| Suite motore, Python 3.13.12 | 533 passati, 1 saltato | Provider finti; un warning Starlette/AnyIO |
| `npm run check` | Passato | Typecheck, 201 test, build web e prototipo |
| `npm run desktop:test` | 11 passati | Processo, protocollo e updater con Electron simulato |
| Architettura | 0 errori, 35 avvisi | Confini e budget di dimensione |
| OpenAPI `--check` | Allineata | Contratto corrente invariato |
| Inventory packaging | 1 passato | Inventario generato; non ricostruzione del pacchetto firmato |
| `git diff --check` | Passato | Nessun errore whitespace |
| Lint globale | 2717 errori, 62 warning | Debito non risolto: 2711 errori di formato, 6 altre violazioni |

Il lint è ora delimitato dai percorsi generati (dist, output, virtualenv e
pacchetti esclusi) e termina. Il confronto su archivio pulito del commit base,
con le stesse dipendenze, dà 2746 errori e 62 warning; le violazioni non di
formato restano identiche (5 `no-explicit-any`, 1 `prefer-const`, 19 avvisi hooks,
43 refresh). Non è un controllo verde né un motivo per riformattare l'intero progetto.

Le regressioni principali sono state viste fallire prima della correzione.
La revisione indipendente ha individuato anche l'ordine dei passi DBOS e la
perdita del conteggio token parziale: entrambi corretti e riverificati. La
prova DBOS usa il runtime reale in un subprocess, un errore subito dopo il
commit del primo step e `fork_workflow(..., 2)` per riusare il journal; produce
esattamente due artifact. È una prova del replay, non un kill/restart completo
dell'applicazione. Il test di deriva delle routine simula l'API scheduler.

## Prova dell'interfaccia

Build web corrente collegata via proxy same-origin a un motore locale isolato,
con dati sintetici in `/tmp/homun-consolidamento-qa/data`, provider finto e
nessun accesso al profilo personale.

- Libreria: lettura del materiale del motore, upload reale di un TXT, contenuto
  leggibile e presenza dopo reload; archiviazione confermata e assenza dopo reload.
- Diniego: risposta 403 controllata nel proxy a una scrittura. Prima della
  correzione rimaneva il testo aperto; dopo la correzione resta l'errore e
  scompaiono lista e anteprima. Il diniego non è lasciato attivo.
- Compiti: data 30 settembre 2026 salvata tramite input nativo e ancora visibile
  dopo reload. Il solo `fill` dello strumento non produceva l'evento di modifica;
  input da tastiera e uscita dal campo hanno verificato il percorso reale.
- Plugin: visibili catalogo curato, server dichiarati e capacità del motore;
  nessun server esterno avviato o permesso aggiunto.
- Layout materiali verificato a larghezza ridotta e ampia. Il popup calendario
  ha arrestato una scheda del browser di prova; la prova scadenza è stata
  completata da tastiera in una nuova scheda.

I test React automatici verificano collegamenti e client al confine delle API;
la verifica montata di upload, diniego e scadenza è la prova browser descritta
sopra, non una suite automatica end-to-end persistente.

## Limiti e seguito

Una chiamata già ammessa può superare un cap token: mancano stima preventiva e
limite affidabile per chiamata. Restano distinti il recupero degli effetti MCP,
identità multiutente, cifratura completa/recupero chiavi e upgrade firmato.
Non sono state ripetute prove con modelli reali o aggiornamenti fra release.

Stato e roadmap sono stati consolidati; la precedente pagina STATO è conservata
in `docs/STATO-2026-09-22.md` con i suoi risultati storici.

L'analisi UX successiva partirà da sei scenari: primo avvio, domanda senza lavoro,
richiesta con materiali, piano con collaboratori, revisione del risultato e
ricorrenza. Per ciascuno: obiettivo, informazioni iniziali, decisioni umane,
feedback, recupero dagli errori e risultato verificabile. Priorità alla coerenza
fra chat, Compiti, Materiali e Documenti e alla comprensione di cosa fare dopo.
