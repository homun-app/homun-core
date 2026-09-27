# Ricognizione branch e riuso delle implementazioni — 27 settembre 2026

## Verdetto

Molte implementazioni esistono già. Non risultano però funzionalità Homun2 più recenti lasciate nei branch di sviluppo esaminati: questi sono antenati del main locale. Il problema residuo prevalente è il collegamento al percorso operativo, seguito da capacità parziali e prove live mancanti. Non va riscritto da zero ciò che è già disponibile.

Verifica: `git fetch origin`, `git ls-remote --heads origin`, `git branch -avv`, `git worktree list`, `git rev-list --left-right --count`, `git merge-base --is-ancestor`, cronologia per file e ricerca dei chiamanti sotto `engine/src/homun`. Nessuno stash presente; main e worktree storica puliti durante l'inventario. Il fetch non ha introdotto nuovi commit remoti.

| Riferimento | Stato rispetto al main locale `39a485fd` |
|---|---|
| `fabio/hermes-parity` (`d9e584cc`) | Già incluso; main contiene altri 22 commit |
| `fabio/hermes-owned-core` (`5ce6646b`) | Già incluso; main contiene altri 145 commit |
| `fabio/production-foundations` (`91261b09`) | Già incluso; main contiene altri 177 commit |
| `origin/main` (`e5155baf`) | Già incluso; main locale avanti di 165 commit, nessun commit remoto mancante |
| `origin/fabio/plan-approval-gate`, `origin/fabio/browser-stall-final-contract`, `origin/legacy/homun-core` | Storia della precedente architettura (`crates`, `runtimes`), non branch più recenti del motore Homun2 `engine/src/homun` |
| `fabio/engine-parity-completion` | HEAD coincide con main; le correzioni recenti sono nella working tree dedicata e non ancora integrate/committate |

Le tre commit di completamento `9f4f03ba`, `aa528063`, `d1d100ec` sono già contenute in main e nella base della worktree corrente. Fare cherry-pick di nuovo non recupererebbe funzionalità mancanti.

## Correzione della lista dei residui

| Ambito | Già presente e da riusare | Residuo concreto |
|---|---|---|
| Documenti | `execution/file_documents.extract` usa gli estrattori DOCX/XLSX/PPTX; `materials.extract` deriva anche da `d1d100ec` | Estrazione workspace già collegata nella worktree; rimuoverla dagli elementi da implementare. Non implica OCR o valutazione formule/layout |
| Terminale | Job approvati, PTY e `PtyQueryResponder`; `VirtualTerminalScreen` in `pty_queries` (`d1d100ec`) | Collegare lo schermo virtuale al terminale, gestire sequenze spezzate; interattività locale/SSH. Continuazione C1a: deadline indipendente dal pump per nuovi job locali verificata; vecchi job e altri backend restano distinti |
| File | Snapshot prima delle scritture in `workspace_file_edits`; manager checkpoint reale | Esporre `get_workspace_working_diff`, `plan_workspace_restore`, `restore_workspace_checkpoint` (`9f4f03ba`) tramite proposte/approvazioni/receipt; LSP ancora unavailable |
| Browser | Registry v3–v5 collega apertura, snapshot, type/click/press, screenshot e iframe | Dialog e console non esposti come tool; i percorsi attivi dismettono i dialog. Completare scroll, input visivo del modello e lifecycle profili/riaggancio |
| Computer | API desktop e bridge macOS/Linux presenti | Registro strumenti agente e autorizzazione da collegare; azioni OS ancora parziali, Windows unavailable |
| Memoria | `memory_tools.execute` usa realmente `ctx.memory`, SQLite/Mem0 e ricerca messaggi autorizzati | Revisione/learning in background, ricerca estesa e port context sostituibile. Backend esterni generici da verificare sui protocolli effettivi |
| Skills | Registry collega ricerca, lettura e creazione supervisionata; bundle checksum/install (`aa528063`) | Risorse progressive/setup, collegamento del bundle al prodotto, sync/update/rollback e curatela |
| Sessioni | `session_manage` collega create/list/resume/fork/import/export/usage al SessionManager | I messaggi dei run non alimentano quel gestore: unificare cronologia e accounting, senza archivio parallelo divergente |
| Canali | Trasporti outbound, pairing, parsing e `ChannelGateway.dispatch_inbound` | Collegare listener/queue/reconnect; upload allegati e recupero consegne. Telegram `send` usa solo sendMessage |
| MCP/plugin | Tool plugin realmente registrati; risorse/prompts/sampling MCP; OAuth token/client-credentials/refresh collegato | OAuth interattivo e elicitation; consumer provider/platform e hook pre-tool dei plugin; auxiliary router non utilizzato dal ModelPort |
| Media | Visione Ollama e TTS macOS say collegati alle route | Image/video/STT senza dispatcher produttivo; pipeline audio delle sessioni vocali |
| Integrazioni | Client HTTP Discord/Feishu/HomeAssistant/Spotify reali e route presenti | Route costruiscono adapter con token vuoto: collegare risoluzione configurazione/credenziali, poi prove live. Non è sufficiente aggiungere una variabile d'ambiente |
| Operazioni/ricerca | Manager daemon, batch runner, serializer trajectory, catalog install/uninstall | restart si limita allo stop; batch API senza executor; trajectory scollegata; inventario cataloghi incompleto |
| Runtime alternativi | Copilot stdio preesistente; nuovi trasporti reali Codex/Relay e proposte ACP nella worktree | Resume/history Codex, listener ACP, integrazione NeMo; nessun collegamento da inventare partendo solo dai nomi delle classi |

La ricognizione ha trovato anche un falso successo residuo in `ManagedToolGateway.invoke_tool`: un token configurato bastava a restituire `Executed` senza IO. Corretto in questa continuazione: il gateway distingue configurazione da trasporto eseguibile, rifiuta l'assenza del dispatcher con codice tipizzato e non espone dettagli delle eccezioni contenenti credenziali. Il trasporto produttivo resta da collegare; questa correzione non completa H39.

## Conseguenze per il piano

Prima di ogni nuova tranche: individuare implementazione e commit di origine, seguire registro → autorizzazione → esecutore → effetto → ricevuta e aggiungere soltanto il collegamento o il comportamento mancante. I vecchi titoli “completo” e i test dei singoli helper non sostituiscono questa verifica.

B2 riusa normalizzazione, risposte parziali e contributi canonici del chiarimento (`56c8db09` e correzioni della worktree), aggiungendo scadenza durevole e ripresa automatica esplicita. Nessuna riscrittura del modulo domande. La revisione indipendente ha verificato 26 casi nuovi, inclusi risposta concorrente alla scadenza, autorizzazione e riapertura SQLite. Il gateway è coperto da 11 test mirati passati; il trasporto produttivo resta indisponibile.

## Nota sull'isolamento di un test

La prima esecuzione RED del nuovo test gateway usava il lifespan dell'app completa e ha aperto il DBOS predefinito locale (`~/Library/Application Support/Homun2/engine/dbos.sqlite`), applicando le migrazioni 115–122. Il log indica zero workflow recuperati e shutdown del runtime. Il test è stato corretto per montare solo il router su una FastAPI isolata. Non è stata tentata una retrocessione delle migrazioni. L'incidente è stato comunicato all'utente; i successivi test gateway non avviano il lifecycle del motore.
