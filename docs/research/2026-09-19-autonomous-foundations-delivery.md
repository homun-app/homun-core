# Fondamenta autonome: sessione, accesso, contesto e ripristino

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

> Verifica successiva: [GUI nativa, correzione storico e nuovo pacchetto](2026-09-19-native-gui-verification.md).

19 settembre 2026. Lavoro locale senza controllo grafico, credenziali reali,
migrazioni dei dati utente, commit, push o distribuzione. Questo documento
aggiorna la [precedente consegna delle autorizzazioni](2026-09-19-work-authorization-delivery.md).

## Cosa cambia

1. **Identità della sessione.** Il launcher desktop imposta esplicitamente il
   principale locale esistente `person_fabio`. Il middleware lega il token a
   quell'identità: integra gli header mancanti e rifiuta identità differenti,
   header duplicati o vuoti. Il nome dichiarato dal renderer non determina
   l'autorità. Il server può ricevere un'identità dal proprio launcher fidato;
   questo non è un nuovo sistema di account o autenticazione multiutente.
2. **Letture e replay autorizzati.** Elenchi/dettagli di lavori e run, eventi e
   metadati dei grant applicano le policy correnti. Una revoca vale anche per
   risultati memorizzati di comandi su progetti, materiali e grant. Le policy
   condivise preservano la normalizzazione degli ID prevista dai gestori.
   [Dettagli e cursori degli eventi](2026-09-19-read-authorization-delivery.md).
3. **Contesto conversazionale tracciabile.** Interpretazione e piano usano fino a
   otto messaggi autorizzati e 12.000 caratteri, senza riscrivere lo storico. Un
   manifest conserva riferimenti, sequenze e hash; non duplica i testi. Le fonti
   vengono ricontrollate dopo le attese, prima del piano, alla pubblicazione e
   al replay. La provenienza passa alle risposte derivate. Corretto inoltre il
   parametro non supportato del costruttore Pydantic AI, verificando il percorso
   nativo con `FunctionModel`, senza rete.
   [Contratto e limiti](2026-09-19-conversation-context-slice.md).
4. **Compatibilità dei backup.** Entrambi i formati rifiutano uno schema workspace
   futuro anche quando checksum e inventario sono corretti. Verifica in sola
   lettura, nessuna destinazione pubblicata dopo un rifiuto; migrazione legacy
   con rollback verificato. [Analisi del confine DBOS](2026-09-19-schema-compatibility.md).
5. **Contratto HTTP riproducibile.** Snapshot OpenAPI generato dall'app corrente
   (42 percorsi), esportatore senza avvio del database e gate CI contro il drift.
   Middleware di sessione e limiti degli schemi generici sono documentati a parte.

I nuovi confini sono moduli piccoli di policy, lettura, composizione del contesto
e adattamento dei modelli. Nessun secondo orchestratore e nessuna espansione
della shell grafica. Il controllo architetturale segnala ancora file grandi
preesistenti: questa consegna non elimina tutto il debito strutturale del repo.

## Ricerca trasformata in decisioni

Il [confronto dei cinque sistemi](2026-09-19-agent-systems-lessons.md) aggiorna
Hermes al commit `236689b9b4ce70099da10a3fabf54bb96898cf45` e usa documentazione
primaria di LangGraph, Letta, OpenHands e Microsoft Agent Framework.

Da Hermes è già stato applicato il confine tra transcript e vista del contesto
per richiesta, aggiungendo le autorizzazioni Homun. Le altre priorità emerse sono
approvazioni legate ad azione/argomenti/revisione e budget aggregati del lavoro.
Restano Pydantic AI per il loop, DBOS per attese/recovery, Homun per dominio e
policy. Non sono stati eseguiti benchmark o runtime dei progetti confrontati.

## Verifiche consolidate

- `npm run engine:test`: **327 passati, 1 saltato**, 59,82 s. Il test saltato
  richiede Mem0 live; rimane una deprecazione Starlette/AnyIO preesistente.
- `npm run check`: **122 test frontend passati**, typecheck, build web e build
  prototipo riusciti. Rimangono avvisi Vite su bundle maggiori di 500 kB.
- `npm run desktop:test` con `HOMUN_TEST_ENGINE` sul nuovo motore incorporato:
  **8 passati**; include lifecycle reale, identità, scadenze e isolamento proxy.
- Review indipendente della slice contesto: nessun blocco concreto rilevato;
  23 test contesto/adattatori rieseguiti e passati, nessuna modifica successiva
  al congelamento dei sorgenti.
- Architettura: **0 errori, 30 avvisi di dimensione**. OpenAPI senza drift;
  `git diff --check` pulito.
- Smoke da sorgenti: quattro sessioni avviate/arrestate con identità del launcher,
  dati temporanei, revoca, negazione dei replay e letture, storico dopo riavvio,
  attesa DBOS ripresa e una sola ricevuta.

Le prove del contesto nel processo usano il provider **fake selezionato
esplicitamente** nel profilo temporaneo: dimostrano persistenza, autorizzazioni e
contratti, non comprensione linguistica o qualità di un modello reale. Il test
Pydantic usa separatamente il modello deterministico della libreria.

## Artefatto verificato

`dist/desktop/2026-09-19T11-06-04-730Z/Homun-0.1.0-macos-arm64.zip`

- Dimensione: **181.732.051 byte**.
- SHA-256 ZIP: `320fec89c84406760c829f49be036b8c705be20cce29a4c06e3c4adb851f14f6`.
- SHA-256 ricevuta motore: `4e13507ca577c79d2cb4842cdc6b11920b9f447cf33ce7918e479f8d4f4204da`.
- CRC archivio, inventario completo motore, corrispondenza dei quattro moduli
  shell nell'ASAR e hash dei sorgenti/lock/build input: verificati.
- **Lo stesso smoke è passato sul binario estratto da questo ZIP**, con
  `PATH=/nonexistent`, senza `PYTHONPATH`, directory e dati temporanei. Migrazione
  DBOS 114 osservata; shutdown regolare e una sola ricevuta persistita.

Questo candidato sostituisce quello `10-10-19` per le modifiche descritte.
Log locali: `/tmp/homun-autonomous-engine.log`, `/tmp/homun-autonomous-web.log`,
`/tmp/homun-autonomous-desktop.log`, `/tmp/homun-autonomous-build.log`,
`/tmp/homun-autonomous-archive.log`. I log temporanei non sono artefatti durevoli.

## Confini ancora aperti

- Nessuna accettazione grafica, installazione su Mac pulito, firma Developer ID o
  notarizzazione. Il pacchetto è un candidato locale verificato senza GUI.
- Identità esterna multiutente, Keychain e cifratura della conservazione dati non
  sono introdotte da questa tranche. Il confine di fiducia resta il processo
  launcher e l'account OS locale.
- Una revoca non ritira contesto già inviato a un provider né annulla effetti I/O
  già accettati. La slice blocca pubblicazione e nuova estrazione del piano,
  senza intercettare ogni retry interno della libreria.
- Compatibilità/rollback dello schema DBOS richiedono un contratto distinto da
  quello workspace: il controllo del backup DBOS resta `quick_check`.
- Budget con prenotazioni atomiche e approvazioni tool con digest degli argomenti
  sono i prossimi due incrementi di motore indicati dalla ricerca, da verificare
  con esecutori deterministici prima di collegare sistemi esterni.
