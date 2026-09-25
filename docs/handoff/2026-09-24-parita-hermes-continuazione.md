# Continuazione: parità completa Homun / Hermes

Data: 25 settembre 2026. Checkpoint del codice: vedi HEAD locale `fabio/hermes-parity` / `main` (nessun push).
Questo documento trasferisce il lavoro a un'altra chat. Non certifica parità raggiunta.


## Progresso 24–25 settembre 2026

Commit locali su `fabio/hermes-parity` (ff su main locale, nessun push):

1. Falsi successi rimossi (H16/H33/H35/H39/H41/H43/H45) — errori tipizzati.
2. Backend reali: Ollama vision + macOS say TTS; probe TCC macOS.
3. Persistenza: goals, sessions, heartbeat/loop, write approvals, deliverable ledger.
4. H03 route side-question; H04 PromptAssembler+@refs nel propose (cwd confinato).
5. H34 gateway SQLite + steering → coda agent_run; H35 MCP runner → pending_approval.
6. H40/H42 ledger approvazioni/consegne su SQLite.
7. H28/H29 CronStore SQLite; prompt jobs senza runner → backend_unavailable.
8. H12 checkpoint su write approvate; H26/H27 inject su claim agent_run.
9. H32 pairing + hosted rooms SQLite; cron prompt → propose pending_approval.
10. Cron due-fire API + Chronos honesty; H10 cloud backends registered; H35 idempotency SQLite; H27 complete_tick.
11. H33: Telegram/Discord/Slack/WhatsApp HTTP send when tokens set; adapter_send honesty.
12. H10: SingularityJobs real exec when CLI present; H36 resources/prompts + sampling/elicitation refuse-by-default.
13. H16: macOS computer-use bridge (osascript/screencapture) auto-wired with TCC-gated readiness.
14. H39: StdioAcpTransport real Copilot ACP JSON-RPC session when CLI present.
15. H33: ntfy + Matrix HTTP adapters registered alongside Telegram/Discord/Slack/WhatsApp/webhook.
16. H10: ModalJobs SDK bridge with HOMUN_MODAL_ALLOW_LIVE spend gate (no unpaid Sandbox.create by default).
17. H10: DaytonaJobs SDK bridge with HOMUN_DAYTONA_ALLOW_LIVE spend gate.
18. H10: Vercel probe + HOMUN_VERCEL_ALLOW_LIVE honesty (client not implemented yet).
19. H10: managed Modal probe + HOMUN_MANAGED_MODAL_ALLOW_LIVE honesty.
20. H33: email SMTP + Signal REST adapters.
21. H33: IRC TCP PRIVMSG adapter; H16 Linux xdotool/wmctrl bridge; H36 discovery-only MCP reconnect.
22. H33: Feishu IM, Mattermost, Google Chat, DingTalk, WeCom channel adapters.
23. H10: Vercel REST sandbox bridge; H36: product MCP sampling opt-in; httpx MCP HTTP fix.
24. H10: managed Modal HTTP exec bridge wired into terminal backend_for.

**Prossimo passo eseguibile:** resto catalogo messaging (Line, SMS, Teams, …); H16 Windows + AX SoM; MCP OAuth/mTLS; prove live con credenziali; prove provider con credenziali. Parità completa H01–H46 ancora aperta.

**Blocchi esterni (non inventare):** token canali reali; TCC Accessibility/Screen Recording per prove H16 live macOS; DISPLAY + xdotool su Linux; `HOMUN_MODAL_ALLOW_LIVE` / `HOMUN_DAYTONA_ALLOW_LIVE` + SDK per prove cloud a pagamento; Copilot CLI con `--acp` per prova H39 live.


## 1. Obiettivo e decisioni già prese

Portare il motore proprio di Homun alla **parità funzionale completa con Hermes Agent**,
partendo dalla logica e dai comportamenti del suo sorgente consolidato. Non usare
Hermes come processo, servizio o motore delegato; non sostituirlo con OpenHands.
Studiare prompt, contratti, gestione del contesto, strumenti e recupero di Hermes,
poi implementarli nel motore Homun, mantenendo attribuzioni e licenze applicabili.

Il perimetro integrale è la matrice H01–H46, comprese le integrazioni e i backend
opzionali nominati nei suoi cataloghi. Non ridefinire la parità come soltanto
“nucleo”, “MVP”, “chat + terminale” o un sottoinsieme scelto per comodità.
La matrice è il contratto di accettazione; questo documento ne indica la ripresa.

Visione di Fabio:

- Homun si usa direttamente in chat, senza dover creare un bot specializzato.
- In alternativa, un onboarding descrive azienda, attività e squadra desiderata.
- Homun aiuta a proporre/configurare collaboratori AI e a collaborare con persone reali.
- Il valore distintivo è organizzare una squadra e migliorare il lavoro aziendale:
  responsabilità, materiali, permessi, costi, risultati e revisione.
- Il confronto listini è una fixture, non il posizionamento del prodotto.
- Prima basi funzionali solide e parità; poi discussione UX e semplificazione.

L'autonomia dello sviluppatore non elimina la supervisione degli agenti nel prodotto.
La proposta di collaboratori e le azioni con effetti devono rispettare i consensi
previsti dai contratti Homun. Non aggiungere invece approvazioni inutili a ogni lettura.

## 2. Stato Git e ambiente

Verificato durante la preparazione di questa consegna:

- Repository principale: `/Users/fabio/Projects/Homun/homun2`, branch `main`.
- Worktree di sviluppo: `/Users/fabio/.codex/worktrees/hermes-owned-core/homun2`.
- Branch di sviluppo: `fabio/hermes-parity`.
- Entrambi al checkpoint codice `f505e160`; alberi puliti prima della consegna.
- La consegna documentale aggiunge un commit successivo al checkpoint codice.
- Modifiche precedenti committate e integrate localmente. Nessun push/deploy certificato.

Ricontrollare sempre stato e differenze: nel frattempo Fabio o altre chat potrebbero
aver lavorato. Non sovrascrivere modifiche altrui, non ricreare il worktree alla cieca.

Ambiente già usato, da verificare nuovamente prima delle prove reali:

- Python 3.13: `/Users/fabio/Projects/Homun/homun2/engine/.venv/bin/python`.
  Non usare il Python di sistema; impostare `PYTHONPATH=engine/src` nelle fixture.
- Worktree con `node_modules` collegato a quello principale, escluso da Git.
- uv: `/opt/homebrew/bin/uv`; Docker: `/usr/local/bin/docker`.
- Docker osservato 29.4.3; immagine locale `debian:trixie-slim`:
  `sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132`.
- Ollama: `http://127.0.0.1:11434/v1`; modello usato `qwen3.5:4b`.
- Usare contesti temporanei isolati. Non modificare profili o dati reali dell'utente.
- Nessun pull implicito di immagini, nessun `docker system prune`, nessun arresto
  di container estranei. Ripulire solo risorse identificate come proprie.

## 3. Ordine di lettura

Leggere prima `AGENTS.md`, poi:

1. [STATO](../STATO.md), ingresso corrente; i rapporti datati conservano prove storiche.
2. [Matrice completa e accettazione](../research/2026-09-23-hermes-parity-matrix.md).
3. [Design approvato](../superpowers/specs/2026-09-23-hermes-parity-design.md).
4. [Uso Homun](../USO-HOMUN.md), per conservare il percorso prodotto.
5. [Ultima verifica file/output](../research/2026-09-24-workspace-files-verifica.md).
6. [Deadline](../research/2026-09-24-terminal-deadline-verifica.md),
   [agente/terminale](../research/2026-09-24-agent-terminal-verifica.md),
   [consenso](../research/2026-09-24-terminal-approval-verifica.md),
   [backend Docker](../research/2026-09-24-owned-terminal-verifica.md).
7. Rapporti del 23 settembre collegati da STATO per loop, controlli, contesto,
   retry/overflow, registry, MCP, risultati, ripetizioni e continuazione.

Non trattare vecchi piani come prova che una funzione sia stata implementata.
In caso di discrepanza controllare codice, test, evidenza e checkpoint del rapporto.

## 4. Riferimento Hermes, attribuzione e perimetro congelato

Checkout di sola consultazione: `/tmp/homun-hermes-reference-20260923`.
Repository: https://github.com/NousResearch/hermes-agent
Commit di riferimento: `c9dca726514b709cf6e677d236a79fc8d0627f37`.
Se il checkout temporaneo non esiste, recuperare quel commit in una directory
separata. Non aggiornare silenziosamente il target alla versione più recente.

Inventario: `docs/research/evidence/2026-09-23-hermes-parity/upstream-manifest.json`.
7965 file censiti, SHA256 del manifest:
`00f3300bbfbab96633bd9c1ee7225823e86bcc163a3bd7ae731d130fdbd9e6d0`.
L'inventario dimostra il riferimento analizzato, non l'equivalenza funzionale.

Notice Homun: `engine/src/homun/notices/hermes-agent.txt`.
Licenza radice MIT, copyright 2025 Nous Research. Verificare anche licenze locali:
security-guidance ha Apache-2.0 con LICENSE/NOTICE; humanizer ha attribuzione MIT
Siqi Chen; achievements MIT contributors; alcuni skill documentali MIT Nous Research.
Non presumere che ogni file erediti soltanto la licenza radice.

Per ogni tranche: individuare i file Hermes reali, leggere implementazione e test,
estrarre comportamenti e limiti, associare la riga Hxx, implementare in Homun e
registrare fonte/attribuzione/evidenza. Se documentazione e codice divergono,
segnalare la divergenza e verificare il comportamento effettivo.

## 5. Cosa è stato implementato

Il nucleo possiede cronologia canonica model/tool/result persistente, lease e
controlli generazionali, autorizzazioni e versioni prima/dopo IO, pausa/ripresa/
annullamento/steering, checkpoint del contesto, retry tipizzati e limitati,
recupero overflow, guardia conservativa alle ripetizioni e continuazione durevole
di risposte troncate. Il bridge MCP offre scoperta progressiva, consenso puntuale,
pin di configurazione/descriptor e receipt persistenti. Risultati grandi vengono
salvati con riferimenti e pagine limitate. Queste sono capacità parziali rispetto
a tutte le varianti upstream, non righe Hxx automaticamente concluse.

Ultime tranche, tutte integrate localmente:

| Commit | Risultato |
| --- | --- |
| `f1d2c740` | Backend Docker proprio, riconnettibile, intenti durevoli |
| `6b6261b8` | Proposte terminali e approvazioni esatte persistenti |
| `02a30302` | Chiamata terminale dal modello e ripresa con receipt canonica |
| `3ab790cd` | Durata approvata e watchdog durevole |
| `f505e160` | File del workspace e consegne immutabili scaricabili |

### Terminale

Container identificati da nome deterministico e label di proprietà/contratto.
Intento esclusivo scritto prima dell'IO. Ripresa tramite inspect, mai redispatch
automatico se il processo è incerto o il container è sparito.
Immagine SHA fissata, `--pull=never`, rete disabilitata, niente home/socket/segreti
host, directory dedicata al run, limiti CPU/RAM/processi e privilegi ridotti.

L'approvazione del run abilita a proporre comandi; ogni comando richiede il proprio
consenso esatto. Il modello riceve un solo risultato sul callID originario quando
il processo è terminato e i log sono disponibili. Log transitoriamente mancanti
lasciano il run in attesa. Revoca/cancellazione non autorizzano un nuovo dispatch.

Timeout dei nuovi comandi 1–3600 secondi, default 300; deadline fissata al primo
consenso. Il watchdog interviene anche se il run è cancellato o l'attore revocato,
con fencing contro osservazioni obsolete. **Funziona mentre il motore/dispatcher è
acceso**; nessun timer indipendente nel container quando Homun è spento. Al riavvio
riconcilia gli scaduti. I vecchi contratti senza durata restano compatibili.
Annullare un agente non prova che il processo sia fisicamente già arrestato.

### File e consegne

Tool nativi: `list_workspace_files`, `read_workspace_file`, `deliver_workspace_file`.
Root derivata dal run; directory-FD e openat, O_NOFOLLOW/O_NONBLOCK; rifiuto traversal,
symlink, hardlink, FIFO e file non regolari. Limite 25 MiB e rilevamento modifiche
con stat prima/dopo. Lista massimo 200 voci con `truncated`, non scansione paginata
completa. Lettura UTF-8 per caratteri; binari descritti con metadati/hash.

Consegna vincolata allo SHA256 letto, snapshot immutabile nei managed blobs,
record `work.output` con ID stabile run/call, provenienza e stato `unreviewed`.
Replay della stessa chiamata restituisce lo snapshot precedente anche se il
workspace è cambiato. Recovery/GC conserva i blob referenziati dagli output.

API autenticate elenco/download, controllo ambito e integrità, allegato
application/octet-stream con nosniff/no-store. Pannello nel dettaglio lavoro.
**La revisione dell'artifact testuale non approva automaticamente i file**.
Non esiste ancora integrazione completa output/materiali/libreria documenti,
né gestione definitiva retention/quota/revisione allegati.

## 6. Mappa del codice per riprendere

Percorsi relativi alla radice repository; i moduli applicativi sono sotto
`engine/src/homun/application/` salvo indicazione diversa.

| Area | Moduli da leggere |
| --- | --- |
| Run, consenso, esecuzione | `agent_runs.py`, `agent_run_execution.py`, `agent_native.py` |
| Registro e bridge | `agent_tool_registry.py`, `agent_tool_bridge.py`, `engine/src/homun/tools/registry.py` |
| MCP esterno | `agent_external.py`, `agent_external_link.py`, `external_tools.py` |
| Risultati grandi | `agent_results.py` |
| Ripresa workflow | `engine/src/homun/runtime/workflows/agent_run.py` |
| Backend | `engine/src/homun/execution/contracts.py`, `cli.py`, `docker.py` |
| Terminale applicativo | `terminal_contracts.py`, `terminal_jobs.py`, `terminal_state.py`, `terminal_watchdog.py` |
| Terminale nativo | `agent_terminal_contracts.py`, `agent_terminal_link.py`, `agent_terminal.py` |
| Accesso file | `engine/src/homun/execution/files.py` |
| Tool file | `workspace_file_contracts.py`, `workspace_files.py` |
| Download e GC | `work_outputs.py`, `material_ingest.py` |

Cercare con `rg --files` i file UI/API per individuarne il percorso effettivo:
`EngineAgentRun.tsx`, `EngineAgentTerminalApproval.tsx`, `EngineWorkOutputs.tsx`,
`EngineWorkspaceWorkPanel.tsx`, `engine-terminal-client.ts`,
`engine-agent-run-client.ts`, `engine-work-outputs-client.ts`,
`routes/terminal.py`, `routes/agent_runs.py`, `routes/work_outputs.py`.
Il dispatcher invoca il watchdog indipendentemente dalla disponibilità di DBOS.

I nuovi run fissano versioni dei tool. Terminale v1 resta supportato; v2 aggiunge
la durata. Tool file abilitati con `_workspace_files_version=1`. Il file executor
è iniettato dal punto canonico di esecuzione per evitare dipendenze circolari.
Non cambiare retroattivamente schema/manifest dei run già salvati.

## 7. Evidenze e limiti della verifica

Ultima verifica del codice `f505e160`, eseguita prima della consegna documentale:

- Engine: **952 passed, 1 skipped**, un warning Starlette/anyio già presente.
- Web: **224 test passati**; typecheck e build passati.
- Architettura: **0 errori, 35 avvisi dimensionali preesistenti**.
- Snapshot OpenAPI coerente con le route.
- Revisione indipendente senza blocchi; 16 test mirati file/output passati.

Prova reale Ollama `qwen3.5:4b` + Docker: il modello chiama terminale, legge il file,
consegna lo snapshot e produce l'artifact finale. Fixture esatta:
`echo HOMUN_FILE_OK > result.txt`; contenuto 14 byte `HOMUN_FILE_OK\n`, SHA256
`79b7a194342dff8dca02d70c40642114ed1f258ebc90402e01b441af712ce0bb`.
Dopo modifica del sorgente, recovery e riapertura SQLite, il download conserva i
byte originali. I test coprono anche crash tra receipt e append canonico, revoca,
integrità, ambito e file ostili.

Fixture in `tools/verification/`: `owned_terminal.py`, `terminal_approval.py`,
`agent_terminal.py`, `terminal_deadline.py`, `agent_files.py`.
JSON sotto `docs/research/evidence/2026-09-23-hermes-parity/`:
`owned_terminal_docker.json`, `terminal_approval_docker.json`,
`agent_terminal_ollama.json`, `terminal_deadline_docker.json`, `agent_files_ollama.json`.

Questi risultati non sono stati rieseguiti per il solo documento di consegna.
Non certificano tutte le varianti provider, una sessione interattiva completa
browser/Electron, l'app installata, un ambiente remoto o un deployment.

## 8. Come continuare concretamente

### H11, tranche successiva a lettura e consegna: fatta in questo aggiornamento

Pagine ordinate, ricerca confinata, lettura per righe, scrittura e patch
protette da lettura/hash, approvazione esatta e ripresa senza seconda scrittura.
Prova Ollama isolata riuscita. Restano language server, V4A e diversi estrattori.
Rapporto: [modifiche file](../research/2026-09-24-workspace-edits-verifica.md).

### H09, sessioni in background sul Docker già approvato: fatta in questo aggiornamento

Un comando con `background: true` resta in esecuzione dopo l'approvazione e
restituisce `job_id`. Il modello può leggere, attendere o arrestare quella
sessione. L'attesa o un avviso unico consegnano la fine; un esito incerto non
rilancia il comando. Arrestare una sessione non tocca le altre. Lo stdin a pipe
e le risposte PTY sono nelle sezioni seguenti. Resta il timer indipendente a motore spento.
Rapporto: [sessioni terminale](../research/2026-09-24-terminal-background-verifica.md).

### Stdin a pipe sulle sessioni background nuove: fatto in questo aggiornamento

`terminal_write` consegna byte allo stdin del container già avviato. Non è un
PTY e non riavvia il comando. Una consegna incerta non viene ripetuta.
Rapporto: [sessioni terminale](../research/2026-09-24-terminal-background-verifica.md).

### Risposte PTY sulle sessioni background nuove: fatte in questo aggiornamento

Un comando con `background: true` e `pty: true` nasce con un terminale.
Homun risponde una sola volta alle richieste di stato, cursore e dimensione
lette nei log nuovi. Non riavvia un container già partito e non è uno schermo
completo. Il ridimensionamento, i segnali e un emulatore restano aperti.
Rapporto: [sessioni terminale](../research/2026-09-24-terminal-background-verifica.md).

### Processo sul computer, facoltativo: fatto in questo aggiornamento

Un run può chiedere comandi su questo computer invece di un container.
Il processo usa la cartella del lavoro e non eredita le variabili d'ambiente.
Ogni comando resta soggetto all'approvazione esatta e non viene riavviato.
Non è isolato dalla rete né dai percorsi assoluti, e non ha stdin né terminale.
Rapporto: [sessioni terminale](../research/2026-09-24-terminal-background-verifica.md).

### Host SSH, facoltativo: fatto in questo aggiornamento

Un run può chiedere comandi su un host SSH indicato nella preparazione.
Homun non usa la configurazione SSH di questo computer, fissa la chiave pubblica
del server nell'approvazione e non copia i file. Ogni comando resta soggetto
all'approvazione esatta e non viene riavviato. Non ha stdin né terminale.
Rapporto: [sessioni terminale](../research/2026-09-24-terminal-background-verifica.md).

### Pagine web pubbliche, facoltative: fatto in questo aggiornamento

Un run può leggere il testo di una pagina http o https pubblica. Gli indirizzi
privati, di loopback e link-local sono rifiutati prima della connessione.
`https://example.com/` restituisce il testo della pagina. Una ricerca nuova
restituisce titoli e URL pubblici; gli indirizzi privati nei risultati sono
scartati. La versione 1 della ricerca resta quella senza provider. Cache,
rescue, provider nominati e X restano assenti.

### Prima tranche consigliata dopo questo aggiornamento: gli altri backend H10

1. Verificare Git e non rifare file, sessioni background, stdin a pipe, risposte PTY, il processo locale e l'host SSH.
2. Leggere in Hermes i backend oltre Docker, il processo locale e SSH.
3. Il processo locale e l'host SSH sono usabili e facoltativi. Non sono container. SSH non sincronizza i file e non ha stdin né terminale.
4. I backend Modal, Singularity, Daytona e Vercel restano assenti:
   non annunciarli. Una credenziale mancante blocca solo la prova di quel backend.
5. Il timer indipendente nel container, quando Homun è spento, resta un limite
   dichiarato finché non esiste un meccanismo proprio.
6. Uno schermo completo, il ridimensionamento e i segnali del PTY restano aperti.

### Tranche successive, ordine da confermare con le dipendenze del codice

- H09/H10: Modal, Singularity, Daytona e Vercel. Il processo locale e l'host SSH
  sono usabili e non sono container. SSH non sincronizza i file. Sessioni Docker, stdin a pipe e risposte PTY restano usabili.
  Restano lo schermo completo e il timer indipendente a motore spento.
- H14/H15: provider nominati, cache, rescue e X; recupero del browser. Una lettura di pagina con cache TTL, ricerca HTML, provider nominati con credenziali dedicate e fallback rescue, ricerca X, e un browser privato sono usabili. Una finestra nativa viene chiusa senza conferma. Un campo di testo si può compilare. Una schermata della pagina si può salvare. I riquadri interni (iframe) pubblici sono esplorabili e i loro campi/pulsanti sono utilizzabili. Accettare una finestra, console e visione restano aperti.
- H17/H18: memoria durevole e motori memoria/contesto sostituibili. L'agente approvato dispone di consultazione memorie (`memory_recall`), memorizzazione con dedup e limiti (`memory_remember`), e ricerca sessione (`session_search`) con autorizzazioni di conversazione e vincoli temporali. Il backend Mem0/vettoriale è opzionale e mantiene SQLite come fonte di verità; background review e learning graph restano aperti.
- H19/H20: caricamento, gestione e provenienza skill; trust/quarantena/setup. L'agente approvato può scoprire competenze approvate (`skill_search`), caricarne le istruzioni su richiesta (`skill_view`) con rifiuto delle bozze in quarantena, e proporre nuove competenze apprese (`skill_propose`) che richiedono approvazione umana esplicita prima dell'attivazione. Hub sync e script di setup restano aperti.
- H21/H22: delegazione/subagenti, risultati e completion durevoli dopo restart. L'agente approvato dispone di delegazione compiti isolati (`delegate_task`) con budget allocato, strumenti dedicati, turni limitati e convalida JSON schema con riparazione fence e conservazione del lavoro grezzo; polling (`delegation_poll`) e cancellazione (`delegation_cancel`) durevoli con stato salvato nel record del run.
- H08: chiarimenti umani strutturati (`clarify`), opzione raccomandata automatica su scelte singole, parsing selezioni multiple (liste, json, csv), domande raggruppate in batch con id filo stabili, conservazione delle risposte parziali in caso di timeout e segnalazione esplicita degli errori di consegna.
- H12: checkpoint del filesystem e rollback selettivo (`CheckpointManager`), ledger delle scritture dell'agente che preserva le modifiche manuali successive dell'utente, rollback selettivo per singolo file, raccolta diff dell'albero di lavoro (`collect_working_diff`) con file non tracciati integrati, e isolamento git worktree per sotto-agenti (`create_subagent_worktree`, `cleanup_subagent_worktree`) con rifiuto sicuro in caso di modifiche non committate.
- H25/H26/H27: obiettivi persistenti su più turni (`GoalManager`, H25) con contratti di completamento (outcome, verification, constraints, boundaries, stop_when), criteri di qualità deterministici (`run_gate`), barriere di attesa su PID/sessione/tempo, giudizio fail-open e pause su budget turni senza Kanban implicito; heartbeat durevoli di sessione inattiva (`HeartbeatManager`, H26) con prelazione dei messaggi umani, coalescenza dei tick e isolamento su reset; loop proattivi (`LoopManager`, H27) a cadenza fissa o auto-adattiva con backoff esponenziale, marcatore `LOOP_COMPLETE`, giudizio `--until`, tetto `--times` e precedenza assoluta degli obiettivi sui tick del loop.
- H28/H29: pianificazione cron durevole (`cronjob_manage`, `CronManager`, H28/H29) con parsing standard a 5 campi (in puro Python), intervalli relativi, timestamp ISO one-shot e trigger ad eventi; validazione preflight; iniezione del contesto a catena (`context_from`); esecuzione script (`no_agent`) ed esecuzione assistita da modello con pin; quota hold con pausa e sblocco; tracciamento incidenti con deduplicazione dei fallimenti e risoluzione; code di consegna per target non locali.
- H30/H31: gestione e persistenza sessioni (`session_manage`, `SessionManager`, `SessionStorage`, H30/H31) con ciclo di vita CRUD, ripristino cwd alla ripresa, rewind dei turni soft-deactivated che preserva l'autorità della cronologia, biforcazioni (fork) con copia dei messaggi e tracciamento genealogico (lineage), esportazione protetta da fuga di credenziali/token, importazione trascrizioni senza deriva di identità, handoff strutturato, storage SQLite in modalità WAL, indicizzazione full-text FTS5 con trigger, verifica di integrità forense (`PRAGMA integrity_check`), autoriparazione (adozione orfani, rebuild FTS) e accounting di token e costi.
- Poi completare tutte le altre righe e integrazioni della matrice. Questo ordine
  non esclude alcuna riga e non sostituisce la verifica dell'esistente.

Evitare di passare tutte le tranche a microcorrezioni del nucleo lasciando ferme
le capacità principali. Ogni tranche deve abilitare un comportamento realmente
utilizzabile, con prove proporzionate e moduli piccoli.

## 9. Tutto il perimetro resta aperto fino a prova

Stato della matrice al checkpoint: H01, H02, H05, H06, H07, H09, H10, H11,
H36, H40 parziali; le altre righe non verificate. “Non verificato” non significa
necessariamente assente: ispezionare prima il codice Homun.

| ID | Ambito da chiudere secondo i dettagli e cataloghi della matrice |
| --- | --- |
| H01–H04 | Loop, streaming/uso/budget, controlli, domande laterali, prompt/istruzioni |
| H05–H08 | Contesto/cache/compressione, recovery/provider, registry, chiarimenti |
| H09–H13 | Terminale, tutti i backend, file/LSP, rollback/worktree, Python/RPC |
| H14–H16 | Web, browser, computer e desktop |
| H17–H20 | Memoria, motori sostituibili, caricamento e ciclo di vita skill |
| H21–H24 | Subagenti, completamento durevole, Kanban, advisor/aggregazione |
| H25–H29 | Obiettivi, heartbeat, proattività, scheduler e sue garanzie operative |
| H30–H35 | Sessioni, storage, gateway, canali, superfici CLI/UI, API compatibili |
| H36–H40 | MCP completo, plugin, provider, adapter alternativi, sicurezza/consensi |
| H41–H46 | Media/voce, deliverable, integrazioni, setup/distribuzione, eval, cataloghi |

Leggere le righe singole nella matrice: questa tabella è soltanto un indice.
Esempi da non dimenticare: backend Modal/Singularity/Daytona/Vercel e i limiti SSH (niente copia dei file, stdin o terminale); risorse,
prompt, sampling, elicitation, OAuth/mTLS MCP; canali e provider nominati;
plugin e skill distribuiti; CLI/TUI/desktop; media e live voice; cataloghi opzionali.
Non eliminare questi requisiti perché meno urgenti o richiedono credenziali.

## 10. Invarianti e criteri di completamento

- Motore Homun proprio; nessuna dipendenza runtime Hermes/OpenHands.
- Stessa chiamata canonica e risultato attribuibile; nessuna ripetizione automatica
  di effetti esterni incerti dopo crash. Unknown, errore e successo distinti.
- Autorità, lease, generazioni e versioni rivalidate attorno all'IO; conservare
  la verità dell'esecuzione anche quando l'utente perde l'accesso al risultato.
- Registro e schemi fissati per run; compatibilità dei contratti precedenti.
- Fonte motore/simulazione esplicita, errori tipizzati, niente fallback silenzioso.
- Piccoli moduli con responsabilità chiare, riuso del proprietario canonico;
  non ingrandire shell UI o orchestratori monolitici.
- Ogni riga conclusa deve avere comportamento confrontato con upstream,
  implementazione raggiungibile, test positivi/negativi e recovery pertinenti,
  evidenza operativa adeguata, documentazione e attribuzioni.
- Una prova finta dimostra il contratto, non il funzionamento del provider remoto.
  Mancano credenziali? Segnalare esattamente quella verifica come bloccata e
  continuare le parti indipendenti; non promuovere la riga a completa.
- Nessuna percentuale inventata. Molti test verdi non equivalgono a parità.
- Parità completa dichiarabile solo quando tutte H01–H46 e i requisiti nominati
  hanno evidenza sufficiente; registrare onestamente ogni limite residuo.

## 11. Comandi e disciplina di integrazione

Dal worktree, dopo aver verificato che sia ancora quello attivo:

```sh
cd /Users/fabio/.codex/worktrees/hermes-owned-core/homun2
git status --short
git log -8 --oneline
git worktree list
PYTHONPATH=engine/src /Users/fabio/Projects/Homun/homun2/engine/.venv/bin/python -m pytest engine/tests -q
/Users/fabio/Projects/Homun/homun2/engine/.venv/bin/python tools/check_architecture.py
/Users/fabio/Projects/Homun/homun2/engine/.venv/bin/python tools/export_openapi.py --check
npm run typecheck
npm test
npm run build
```

Per test mirati recenti: `engine/tests/test_workspace_files.py`,
`test_work_outputs.py`, `test_docker_jobs.py`, `test_terminal_jobs.py`,
`test_agent_terminal.py`, `test_terminal_deadline.py` (tutti sotto engine/tests).
Eseguire prima i test pertinenti; ampliare ai gate richiesti prima di integrare.

Esempio di fixture reale, solo dopo verifica Docker/Ollama e immagine presente:

```sh
PYTHONPATH=engine/src /Users/fabio/Projects/Homun/homun2/engine/.venv/bin/python tools/verification/agent_files.py --image sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 --output /tmp/homun-agent-files-rerun.json
```

Leggere `--help` e lo script prima di rieseguire fixture se sono cambiati.
Conservare rapporti storici e aggiungere le nuove evidenze senza fingere che
il vecchio risultato certifichi il nuovo codice.

Fabio ha autorizzato lavoro autonomo, test, documentazione, commit e merge locali.
Committare tranche coerenti su `fabio/hermes-parity`, controllare main pulito e
integrare con `git merge --ff-only fabio/hermes-parity` dal repository principale.
Se i branch divergono, analizzare senza reset distruttivi. Non usare co-author.
Non riscrivere storia pubblicata: il progetto è collegato a Lovable.
Non assumere autorizzazione a push, release o deployment.

## 12. Continuità fra chat

La nuova chat non eredita necessariamente strumenti, obiettivo persistente,
processi, terminali o subagenti della precedente. I documenti/Git sono il punto
comune. Ricostruire lo stato senza aspettare agenti dal nome visto in vecchi log.
Se dispone di uno strumento obiettivi, leggere l'obiettivo già presente e,
solo se assente, crearne uno equivalente su esplicita istruzione del prompt sotto.
Nessun budget numerico è stato richiesto. Non segnare completo a fine tranche.

## 13. Prompt da incollare nella nuova chat

> Continua autonomamente lo sviluppo di Homun fino alla parità funzionale completa
> con Hermes Agent. Il repository è /Users/fabio/Projects/Homun/homun2. Leggi per intero
> docs/handoff/2026-09-24-parita-hermes-continuazione.md, AGENTS.md, docs/STATO.md,
> docs/research/2026-09-23-hermes-parity-matrix.md e il design collegato.
>
> Questa è una richiesta di esecuzione, non soltanto di analisi o di un nuovo piano.
> Il target è tutta la matrice H01–H46, incluse integrazioni, backend e cataloghi
> opzionali nominati. Non ridurre l'obiettivo al nucleo/MVP. Usa come riferimento
> Hermes al commit c9dca726514b709cf6e677d236a79fc8d0627f37: studiane sorgenti,
> prompt e test e implementane la logica nel nostro motore, rispettando licenze
> e attribuzioni. Non usare Hermes o OpenHands come runtime.
>
> Homun deve funzionare subito come assistente generalista in chat e offrire
> onboarding opzionale per creare una squadra di persone e agenti in azienda.
> Mantieni responsabilità, consensi, materiali, costi, risultati e revisione.
> Il confronto listini è solo una fixture. La discussione UX generale viene dopo
> il consolidamento funzionale; rendi comunque utilizzabili le capacità nuove.
>
> Riparti dal codice esistente: checkpoint f505e160, più il successivo commit
> documentale di consegna; main e fabio/hermes-parity erano allineati. Verifica
> lo stato attuale prima di modificare. Il worktree usato è
> /Users/fabio/.codex/worktrees/hermes-owned-core/homun2. Non perdere cambiamenti
> altrui e non rifare le tranche già completate.
>
> Il motore ha loop nativo persistente, controlli e recupero, bridge MCP con
> consensi, terminale Docker proprio approvato e riprendibile, watchdog,
> lettura file confinata, consegne immutabili, ricerca, lettura per righe e
> modifiche approvate. Sono capacità parziali: non dichiarare raggiunta la parità.
> Le prove sono 1002 test engine passati/1 skipped, 226 web, OpenAPI e
> architettura verdi, più container Docker isolati, uno stdin a pipe, una
> risposta PTY, un processo locale, un host SSH usa e getta, la pagina
> pubblica example.com, un Chrome headless con profilo proprio, una finestra
> nativa chiusa senza conferma, un campo compilato su quella pagina, una
> schermata PNG della pagina e l'interazione con un modulo dentro un iframe pubblico. Non trattarle come parità completa.
>
> H11 ha ora pagine, ricerca, lettura per righe, scrittura e patch approvate,
> con prova Ollama isolata. Restano language server, V4A e diversi estrattori:
> non dichiararli chiusi. Il terminale Docker ha sessioni in background con
> poll, attesa, arresto, un solo avviso di completamento, stdin a pipe e
> risposte alle richieste di stato, cursore e dimensione su un terminale nuovo.
> Non è uno schermo completo. Un processo sul computer è usabile e facoltativo:
> non eredita l'ambiente e non è un container. Un host SSH è usabile e
> facoltativo: la chiave pubblica del server è fissata nell'approvazione e i
> file non vengono copiati. Una pagina http pubblica è leggibile e gli
> indirizzi privati sono rifiutati. Una ricerca nuova restituisce titoli e URL
> pubblici. I provider nominati, la cache e X restano aperti.
> Modal, Singularity, Daytona e Vercel restano aperti: non dichiararli chiusi
> senza una prova; qui mancano i programmi e le credenziali.
> Un browser privato legge una pagina pubblica, chiude una finestra nativa
> senza confermarla, compila un campo di testo, salva una schermata di quella
> pagina, interagisce con controlli dentro riquadri (iframe) pubblici e chiude solo quel processo. Accettare una finestra,
> console e visione restano aperti.
> Il prossimo lavoro sono i provider di ricerca nominati, la cache e rescue, poi memoria, skill,
> delegazione e tutte le restanti righe secondo dipendenze. L'ordine è modificabile
> con motivazione tecnica, il perimetro completo no. Ispeziona sempre ciò che
> Homun possiede già prima di dichiararlo assente o creare percorsi paralleli.
>
> Lavora in tranche verificabili: confronto upstream, piano breve, implementazione,
> test pertinenti, prove reali isolate, aggiornamento matrice/STATO/rapporti,
> commit e merge locali. Preserva autorizzazioni, versioni, receipt canoniche,
> compatibilità e assenza di doppia esecuzione dopo crash. Non confondere un
> esito incerto con un fallimento senza effetti. Segui le regole sui moduli piccoli.
>
> Hai autorizzazione a proseguire autonomamente con codice, test, documenti,
> commit e merge locali, senza chiedermi conferma per ogni tranche. Non fare push
> o deploy e non riscrivere storia pubblicata; niente co-author. Chiedi solo
> informazioni indispensabili non ricavabili, continuando intanto il resto.
> Credenziali mancanti bloccano quella prova, non giustificano tagliare l'obiettivo.
>
> Se hai strumenti per obiettivi persistenti, riusa quello equivalente oppure,
> se assente, crea l'obiettivo di parità completa descritto qui, senza budget
> numerico. Non marcarlo completo finché ogni riga e integrazione richiesta
> dispone di evidenza adeguata. Se devi trasferire nuovamente il lavoro, aggiorna
> questa consegna con checkpoint, prove, limiti e prossimo passo concreto.
