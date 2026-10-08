# Consolidamento dopo la rianalisi

> Esecuzione con superpowers:subagent-driven-development, test di regressione e revisione. Il rapporto del 23/9 e la prosecuzione esplicita di Fabio autorizzano questa tranche; l'analisi UX approfondita segue dopo le correzioni.

**Obiettivo:** correggere i sei difetti verificati, rivalidare le fonti della sintesi e allineare documentazione e controlli al prodotto effettivo.

**Architettura:** conservare dominio, policy e API esistenti. Le viste motore devono usare gli stessi client e la stessa persistenza dei tool. Separare l'attore autorizzante dall'assegnatario contabilizzato senza concedere permessi nuovi. Continuazioni e schedule devono convergere sullo stato persistente.

**Stack:** Python/pytest/DBOS, React/TypeScript, Electron/node:test.

## 1. Contratti del motore

File: `runtime/workflows/tool_chain.py`, `application/routines.py`, `application/budgets.py`, `application/synthesis.py`, `application/synthesis_execution.py` sotto `engine/src/homun`; test corrispondenti sotto `engine/tests`.

- [x] Trasformare le tre riproduzioni del rapporto in regressioni che chiedono il comportamento corretto: catena interrotta dopo artifact ripresa senza duplicati; allocazione esaurita impedisce la sintesi prima della chiamata; cron/fuso discordanti vengono riconciliati.
- [x] Vedere i test fallire, poi correggere i confini minimi. La continuazione deve essere idempotente senza riattivare lavori cancellati o revisionati. L'allocazione consuma anche il budget globale, mantenendo la persona come autorità. Gli schedule conservano lo stato pausa.
- [x] Provare fonti cambiate prima/dopo approvazione e durante la sintesi: confronto dei binding materiale e revisione procedure, nessun artifact su fonti non più approvate.
- [x] Verificare successo normale, esaurimento, replay e revoche con suite mirate; revisione dei requisiti e poi qualità del codice.

## 2. Ingressi frontend autorevoli

File: `ConversationWorkspaceSpaceHost.tsx`, `ConversationWorkspace.tsx`, `ConversationTasks.tsx`, `ConversationCapabilitiesSettingsSection.tsx`, nuovo pannello `EngineMaterials.tsx` e modulo piccolo per operazioni libreria, test sotto `tests`.

- [x] Materiali: elencare materiali reali dei progetti autorizzati, scegliere progetto per ingestione, usare `ingestEngineMaterial`/`archiveEngineMaterial` e `notifyMaterialChange`; riusare i riferimenti del motore. Nessun callback simulato nel ramo motore. Ricerca e filtro progetto, caricamento file/cartella, stato ed errori espliciti. Non introdurre permessi o collegamenti multiprogetto inesistenti.
- [x] Plugin: riusare `ConversationMcpSettingsSection` e catalogo capability dalla vista laterale. Rimuovere l'affermazione obsoleta di indisponibilità MCP. Mantenere simulazione nel suo ramo esplicito.
- [x] Compiti: delegare la modifica scadenza a `engine.setDue` in modalità motore, mantenere `setWorks` per simulazione; input in attesa e `HomunErrorNotice` su fallimento.
- [x] Test su API reali simulate al solo confine fetch e collegamenti delle viste; typecheck e prova browser su profilo temporaneo.

## 3. Updater

File: `apps/desktop/src/updater.cjs`, `apps/desktop/tests/updater.test.cjs`.

- [x] Regressione con modulo reale ed Electron simulato: un controllo manuale con aggiornamento disponibile deve produrre un solo dialogo anche dopo «Più tardi».
- [x] Un solo punto decide il dialogo; verificare controllo automatico, assenza aggiornamento, errore e download in corso senza scaricare release vere.
- [x] Eseguire tutta la suite desktop; distinguere questi test da un aggiornamento firmato completo.

## 4. Chiusura e preparazione UX

- [x] Consolidare `docs/STATO.md`, `roadmap.md` e README desktop senza alterare le prove storiche; distinguere capacità presenti e limiti ancora aperti.
- [x] Verificare `npm run check`, suite motore completa, suite desktop, architettura, OpenAPI e inventario packaging.
- [x] Rendere delimitata la scansione lint degli artefatti generati; riportare separatamente eventuale debito preesistente senza formattazione massiva.
- [x] Verificare visivamente le superfici modificate su build corrente con dati di prova; non modificare il profilo personale o installare release.
- [x] Revisione finale e rapporto delle prove. Il successivo lavoro UX partirà da scenari completi (primo avvio, domanda, lavoro con materiali, collaborazione, revisione, ricorrenza), prima di proporre un nuovo disegno.

La firma/notarizzazione, una pubblicazione release, l'identità multiutente e la riscrittura del runtime MCP sono fuori da questa correzione. L'updater sarà verificato nel confine modificato, senza dichiarare una certificazione di upgrade reale.

Risultati e limiti: [rapporto di verifica](../../research/2026-09-23-consolidamento-verifica.md).
