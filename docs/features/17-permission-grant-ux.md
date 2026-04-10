# Permission / Grant UX & Runtime Safety

> **Dominio**: UX delle negazioni (sandbox, shell, ACL) + flow di escalation dei grant + continuazione del budget iterazioni.
> **Status**: IMPLEMENTATO (PR 1-4) — diagnostica, escalation block, grant persistence, Seatbelt macOS 26 fix.
> **Ultimo aggiornamento**: 2026-04-06

---

## 1. Problema Utente

Quando l'agente tenta un'operazione bloccata da un layer di sicurezza (sandbox kernel, shell safety filter, ACL permission) oggi l'utente vede:

```
Tool: shell
Input: rm /Users/fabio/.homun/workspace/*.csv
Output: [exit code: -1]
```

Questo è **opaco**: non si capisce chi ha bloccato, perché, né cosa fare. Risultato:
1. L'agente riprova con 5-10 varianti diverse → brucia iterazioni
2. Il budget si esaurisce senza feedback utile
3. L'utente riceve `(max iterations reached without final response)`
4. L'utente non sa se continuare, cambiare approccio o intervenire sulla config

Questa feature descrive il **flow atteso completo** e l'infrastruttura necessaria.

---

## 2. Scenari di Denial

### 2.1 Sandbox Kernel Denial (Seatbelt / Bubblewrap / Docker)

Il kernel-level sandbox (macOS Seatbelt, Linux Bubblewrap, Docker isolation) può negare un syscall **silenziosamente** killando il processo con SIGKILL. Il parent vede `exit code: -1` (da `status.code().unwrap_or(-1)` in `src/tools/shell.rs:509`) senza nessun messaggio.

**Esempi di trigger**:
- Scrittura/delete fuori dal path `WORKSPACE` (Seatbelt `file-write*` subpath).
- Accesso a dotfile di shell (`~/.zshrc`) che il profilo non include.
- Connessione di rete quando `docker_network = "none"` o Seatbelt profile blocca network.
- Fork/exec in un sandbox che lo vieta.

**Oggi**: nessun segnale utile, solo `-1`.
**Atteso**: il tool riconosce il SIGKILL come possibile sandbox denial e propone un **Escalation Block**.

### 2.2 Shell Safety Filter Denial (`src/tools/shell.rs`)

Le 5 layer di safety check pre-spawn restituiscono stringhe tipo:
```
BLOCKED (destructive command): matches deny pattern 'rm -rf /'
BLOCKED (risky command): 'kill -9' — enable allow_risky in config to permit
BLOCKED (workspace restriction): path traversal or absolute path detected
BLOCKED (whitelist mode): 'git' not in allowed commands
```

**Oggi**: ritorna `ToolResult::error(reason)` con messaggio leggibile, ma nessuna azione proposta.
**Atteso**: propone Escalation Block con opzioni di grant se il grant è appropriato.

### 2.3 ACL Permission Denial (`src/tools/file.rs` → `check_path_permission`)

Il Permission System (`PermissionsConfig` in `config.toml`) ritorna 3 esiti:
- `PermissionResult::Allowed` — operazione consentita
- `PermissionResult::Denied(reason)` — negata, con motivo
- `PermissionResult::NeedsConfirmation(reason)` — richiede conferma

**Oggi**: il `NeedsConfirmation` non ha un flow UX end-to-end uniforme.
**Atteso**: stesso Escalation Block del shell denial.

### 2.4 Approval Manager Gate (`src/tools/approval.rs`)

Già implementato per shell a `src/agent/agent_loop.rs:1835-1909` e per siti web a `1911-1956`. Presenta un **ChoiceBlock** con 3 opzioni:
- `allow_once` → `grant_one_time_pass(base_cmd)`, comando eseguito una volta.
- `allow_always` → `approve_with_cmd(id, base_cmd)`, aggiunto a `session_allowlist` (in-memory).
- `deny` → `deny(id)`, rifiutato con messaggio all'LLM.

**Limite attuale**: grant solo session-scoped (non persistiti), solo sul `base_cmd` (non su path, non su pattern).

---

## 3. Escalation Block (UX Unificata) — da costruire

Quando una operazione viene bloccata in uno degli scenari sopra, il tool deve produrre un **ResponseBlock::Choice** con struttura:

```
🔒 Operazione bloccata

Cosa: rm /Users/fabio/.homun/workspace/*.csv
Dove: /Users/fabio/.homun/workspace/
Motivo: macOS Seatbelt sandbox — path non consentito al write
Tentativo: 3/3 (budget rimasto: 8 iterazioni)

Cosa vuoi fare?
  [Permetti solo ora]      ← session grant, 1 esecuzione
  [Permetti sempre path]   ← persistito in config (sandbox.allow_paths)
  [Permetti sempre comando]← persistito in config (shell_permissions.allowed_commands)
  [Nega e spiega all'agente]← LLM riceve errore strutturato, adatta
```

### Metadata del block
```json
{
  "id": "shell_escalation_<nonce>",
  "kind": "choice",
  "title": "Operazione bloccata",
  "subtitle": "macOS Seatbelt — path non consentito al write",
  "context": {
    "tool": "shell",
    "operation": "write_file",
    "target_path": "/Users/fabio/.homun/workspace/*.csv",
    "command": "rm /Users/fabio/.homun/workspace/*.csv",
    "denier": "macos_seatbelt",
    "denier_layer": "kernel_syscall",
    "attempts_in_conversation": 3
  },
  "options": [
    { "id": "once", "label": "Permetti solo ora", ... },
    { "id": "always_path", "label": "Permetti sempre path", ... },
    { "id": "always_cmd", "label": "Permetti sempre comando", ... },
    { "id": "deny", "label": "Nega", ... }
  ]
}
```

### Dispatch delle scelte

| Option ID | Persistenza | Dove | Scope |
|---|---|---|---|
| `once` | Session | `ApprovalManager.session_grants: HashSet<GrantKey>` | Fino a fine sessione chat |
| `always_path` | Config | `security.execution_sandbox.allow_paths: Vec<String>` | Persistente, path-specific |
| `always_cmd` | Config | `security.shell_permissions.{os}.allowed_commands: Vec<String>` | Persistente, command-specific |
| `deny` | Transient | LLM riceve `ToolResult::error("User denied grant: use alternative approach")` | Singola invocazione |

### Grant Key (per grant puntuali)
```rust
pub enum GrantKey {
    ShellCommand { base_cmd: String },
    FilePath { path: PathBuf, op: FileOp },
    SandboxPath { path: PathBuf },
    WebDomain { domain: String },
}
```

---

## 4. Budget Continuation Flow (esiste, da fixare)

### 4.1 Stato attuale

In `src/agent/agent_loop.rs:2574-2649` esiste già un flow di continuazione:

```rust
// Quando budget esaurito e sotto hard_max:
// 1. Presenta ChoiceBlock "Continue?" con 2 opzioni: [continua, finalize]
// 2. Registra gate, aspetta risposta utente (timeout 300s)
// 3. Se "continua" → active_iteration_budget += 20
// 4. Il loop prosegue con budget esteso
```

### 4.2 Bug fixato (PR 2)

Il flow esisteva ma aveva tre problemi:

1. **Race condition**: `gate.register()` veniva chiamato DOPO `tx.send()` — se l'utente cliccava velocemente, il response arrivava prima che il gate esistesse → click ignorato silenziosamente. **Fix**: register PRIMA di send.

2. **Zero tracing**: quando `stream_tx` era `None` (canali senza WebSocket), il block veniva silenziosamente skippato senza log. **Fix**: `tracing::warn!` con `block_outcome` per 7 stati diversi (`skipped_no_stream`, `skipped_hard_max_reached`, `send_failed`, `user_continued`, `user_finalized`, `channel_closed`, `timeout`).

3. **Fallback opaco**: il messaggio `"(max iterations reached without final response)"` non diceva nulla all'utente. **Fix**: messaggio con conteggio iterazioni, tool calls, SIGKILL hints, e suggerimenti actionable (`/estop`, "rephrase the task").

### 4.3 UX migliorata del continuation block

Quando il budget scade, il block dovrebbe mostrare:

```
⚠️ Budget iterazioni esaurito (11/11)

Cosa ho fatto:
  ✓ Esplorato workspace (1 tool call)
  ✗ 10 tentativi di eseguire rm/ls/find — tutti killati da sandbox

Probabile causa: macOS Seatbelt sta negando silenziosamente le scritture
(rileva SIGKILL su exit -1, ma profile dice fs=workspace-rw)

Cosa vuoi fare?
  [Continua con budget +20]        ← reset contatori, nuovo budget
  [Cambia approccio]                ← new user message, session continua
  [Ferma e diagnostica]             ← suggerisce /estop + check logs
  [Permetti rm permanentemente]     ← escalation shortcut (skip denial)
```

### 4.4 Reset semantics

Quando l'utente clicca "Continua con budget +20":
- `active_iteration_budget += 20` (max: `hard_max_iterations = 75`)
- `IterationBudgetState` **non resettato** — lo stall streak persiste per evitare budget runaway
- `cycle_detected` persiste — se il ciclo si ripresenta, budget contratto di nuovo
- Session messages e cognition result preservati

---

## 5. Diagnostica Runtime (Troubleshooting)

### 5.1 Come diagnosticare exit -1

1. **Verifica backend sandbox attivo**:
   ```bash
   grep -A 2 "execution_sandbox" ~/.homun/config.toml
   # se backend = "auto" o "macos_seatbelt" + strict = true → sospetta Seatbelt
   ```

2. **Leggi sandbox events log**:
   ```bash
   tail -20 ~/.homun/logs/sandbox-events.jsonl | jq 'select(.execution_kind=="shell")'
   # cerca "resolved_backend" e "status"
   ```

3. **Test comando fuori da Homun**:
   ```bash
   rm /Users/fabio/.homun/workspace/test.csv && echo OK
   # se funziona fuori ma non dentro → conferma sandbox denial
   ```

4. **Test con sandbox disabilitato (temporaneo)**:
   ```toml
   [security.execution_sandbox]
   enabled = false
   ```
   Se funziona con `enabled=false` → confermato Seatbelt denial.

### 5.2 Segnali Unix più comuni

Su `status.signal()` (Unix), i segnali più comuni quando sandbox killa:
| Segnale | Numero | Significato probabile |
|---|---|---|
| **SIGABRT** | **6** | **macOS Seatbelt denial** — il sandbox chiama `abort(3)` sul processo quando viola il profilo. Confermato empiricamente (2026-04-05). |
| SIGKILL | 9 | OOM killer, explicit kill, Linux Bubblewrap deny |
| SIGSEGV | 11 | Crash, memory violation |
| SIGPIPE | 13 | Broken pipe (stdout chiuso prematuramente) |
| SIGTERM | 15 | Timeout, graceful termination request |

**Insight**: mentre Docker e Bubblewrap tendono a SIGKILL, **macOS Seatbelt usa SIGABRT**. Il shell diagnostic copre tutti i signal terminations.

**Fix implementato** (`shell.rs:509+`): quando `status.code()` è `None`, `describe_termination()` estrae `status.signal()` via `ExitStatusExt`, risolve il backend via `resolve_sandbox_backend()` (non la config raw), e aggiunge una sezione `[diagnostic]` al tool output che l'LLM può leggere e usare per adattare la strategia (es. suggerire escalation o tool alternativo).

---

## 6. Architettura Grant Persistence

### 6.1 Config additions (proposta)

```toml
[security.execution_sandbox]
enabled = true
backend = "auto"
strict = true
# NUOVO:
allow_paths = [
  "/Users/fabio/.homun/workspace/**",
  "/Users/fabio/Projects/**"
]
# Paths in allow_paths vengono aggiunti al profilo Seatbelt/Bubblewrap come extra subpath allow rules

[security.shell_permissions.macos]
allow_risky = false
allowed_commands = []  # già esiste
blocked_commands = []  # già esiste
# NUOVO:
allow_paths = [
  "/Users/fabio/.homun/workspace/**"
]
# Usato dal shell workspace restriction check (layer 4)
```

### 6.2 Session-scoped grants (da aggiungere a ApprovalManager)

```rust
pub struct ApprovalManager {
    // ... existing fields ...
    session_path_grants: Mutex<HashSet<PathBuf>>,
    session_cmd_grants: Mutex<HashSet<String>>,  // già esiste come approved_commands
}

impl ApprovalManager {
    pub fn grant_session_path(&self, path: &Path) { ... }
    pub fn is_path_session_granted(&self, path: &Path) -> bool { ... }
}
```

### 6.3 Seatbelt runtime path injection

Il profilo Seatbelt attuale (`seatbelt_profile.sbpl`) accetta solo 1 param `WORKSPACE`. Per supportare `allow_paths` servono **N subpath allow rules** generate dinamicamente:

```scheme
;; Generato runtime:
(allow file-read* file-write*
  (subpath (param "WORKSPACE"))
  (subpath "/Users/fabio/.homun/workspace")
  (subpath "/Users/fabio/Projects")
)
```

Oppure approccio alternativo: generare il profilo a runtime concatenando regole, invece di usare un file statico con 1 param.

---

## 7. Stato Implementazione

| Componente | Stato | Location | PR |
|---|---|---|---|
| `ResponseBlock::Choice` | ✅ Esiste | `src/tools/response_blocks.rs` | — |
| ChoiceBlock 3-option pattern | ✅ Esiste | `agent_loop.rs:1835-1909` | — |
| `ApprovalManager` one-time + always grants | ✅ Esiste (session only) | `src/tools/approval.rs:262-299` | — |
| Budget continuation ChoiceBlock | ✅ Fixato (race condition + tracing) | `agent_loop.rs:2594-2700` | PR 2 |
| Sandbox denial detection (signal→diagnostic) | ✅ Implementato | `src/tools/shell.rs` `TerminationInfo` | PR 1 |
| Escalation Block (Allow Once / Always / Deny) | ✅ Implementato | `src/tools/shell.rs` `build_sandbox_escalation_block()` | PR 3+4 |
| `ExecutionSandboxConfig.allow_paths` | ✅ Implementato | `src/config/schema.rs` | PR 4 |
| Seatbelt runtime path injection | ✅ Implementato | `src/tools/sandbox/backends/macos_seatbelt.rs` `append_allow_paths()` | PR 4 |
| Session sandbox bypass grants | ✅ Implementato | `src/tools/approval.rs` `grant/consume_sandbox_bypass()` | PR 3 |
| Grant persistence to config | ✅ Implementato | `agent_loop.rs` allow_always handler | PR 4 |
| macOS 26 Seatbelt compatibility | ✅ Fixato | `seatbelt_profile.sbpl` + `seatbelt_profile_net_local.sbpl` | PR 4 |
| Shell sh fallback under sandbox | ✅ Implementato | `src/tools/shell.rs` execute() | PR 4 |
| `ShellPermissions.allow_paths` | ❌ Futuro | `src/config/schema.rs` | — |
| Troubleshooting CLI (`homun doctor`) | ❌ Futuro | — | — |

---

## 8. Casi d'uso end-to-end

### Caso 1: Utente chiede di eliminare file CSV
1. User → "elimina tutti i csv"
2. Agent → shell call `rm /Users/fabio/.homun/workspace/*.csv`
3. Seatbelt kill silenzioso → SIGKILL → exit -1
4. **NUOVO**: Shell tool rileva SIGKILL, verifica backend Seatbelt attivo, emette Escalation Block:
   ```
   🔒 Operazione bloccata da sandbox
   [Permetti solo ora] [Sempre per questo path] [Nega]
   ```
5. User clicca "Sempre per questo path"
6. **NUOVO**: Config aggiornato con `execution_sandbox.allow_paths += ["/Users/fabio/.homun/workspace/**"]`, profilo Seatbelt rigenerato, comando eseguito.
7. Agent → "Ho eliminato i 10 file CSV"

### Caso 2: Budget esaurito durante loop
1. Agent tenta 11 varianti di comando → tutte killate da Seatbelt
2. Budget raggiunge 11/11
3. **FIX**: Continuation block mostrato con sintesi errori rilevata:
   ```
   ⚠️ Budget esaurito
   Ho rilevato 11 SIGKILL consecutivi — probabile sandbox denial
   [Escalation shortcut] [Cambia approccio] [Continua +20]
   ```
4. User clicca "Escalation shortcut" → mostrato Escalation Block dal Caso 1 → grant concesso → esecuzione.

---

## 9. Dipendenze

- **Da cosa dipende**:
  - `src/tools/response_blocks.rs` (Choice block)
  - `src/tools/approval.rs` (grant manager)
  - `src/tools/sandbox/backends/` (backend denial detection)
  - `src/config/schema.rs` (allow_paths fields)
  - `src/agent/approval_gate.rs` (block registration)

- **Cosa dipende da questa feature**:
  - Shell tool (principale consumer)
  - File tool (secondary)
  - Skill executor (edge case)
  - Web UI Settings page (gestione grant persistenti)
  - Browser site approval (pattern già simile, potrebbe unificarsi)

---

## 10. Open Questions

1. **Dove centralizzare il denial detection?** In ogni tool o in un wrapper comune (middleware)?
2. **Come gestire multi-OS grant paths?** Serve un field per OS (`shell_permissions.macos.allow_paths`) o un campo globale?
3. **Hot-reload dei grant persistiti?** Se Seatbelt profile è cachato per-sandbox-invocation, basta. Se ha stato runtime, serve hot-reload.
4. **Audit trail dei grant permanenti?** Log in `vault_access_log` o nuova tabella `permission_grants`?
5. **Revoca grant da UI?** Pagina Web UI `/permissions` già esiste, basta aggiungere sezione "Granted paths/commands".
6. **Cosa fare quando l'utente è in channel CLI o Telegram?** Il ChoiceBlock rendering varia per canale — CLI potrebbe usare numeric prompt, Telegram inline keyboard.

---

## 11. File di Riferimento

| Area | File | Ruolo |
|---|---|---|
| Shell denial | `src/tools/shell.rs:443-509` | spawn + wait, exit code handling |
| Seatbelt backend | `src/tools/sandbox/backends/macos_seatbelt.rs:53-70` | WORKSPACE param setup |
| Seatbelt profile | `src/tools/sandbox/backends/seatbelt_profile.sbpl:138-140` | allow rules |
| Shell approval block | `src/agent/agent_loop.rs:1835-1909` | pattern da riusare |
| Budget continuation | `src/agent/agent_loop.rs:2574-2649` | flow da fixare |
| Approval manager | `src/tools/approval.rs:58-82, 262-299` | grant storage |
| Response blocks | `src/tools/response_blocks.rs:14-26` | UI structure |
| Shell config | `src/config/schema.rs:2076-2156` | `ShellPermissions` + `OsShellProfile` |
| Sandbox config | `src/config/schema.rs:2380-2432` | `ExecutionSandboxConfig` |
| Sandbox events log | `src/tools/sandbox/events.rs:100-129` | per troubleshooting |
| Sandbox events file | `~/.homun/logs/sandbox-events.jsonl` | runtime log |

---

## 12. Prossimi Step

### 12.1 Migrazione completa Config → DB (sessione dedicata)

La sezione `security` + `permissions` è già persistita nel DB (tabella `settings`, migration 052). Il pattern è stabilito:
- Tabella `settings(section PK, value_json, updated_at)` — una riga per sezione config
- `overlay_db_settings()` all'avvio: DB overrides TOML
- `save_config_section()` al save: DB primary, TOML backup
- Section constants in `src/config/mod.rs`

**Da fare**: migrare TUTTE le restanti sezioni config dallo stesso pattern. Elenco sezioni da migrare:

| Sezione TOML | Section key proposta | Endpoint API che scrive |
|---|---|---|
| `agent` | `agent` | `providers.rs` (modello, temperature, ecc.) |
| `channels.telegram` | `channels.telegram` | `channels.rs` |
| `channels.whatsapp` | `channels.whatsapp` | `channels.rs` |
| `channels.discord` | `channels.discord` | `channels.rs` |
| `channels.slack` | `channels.slack` | `channels.rs` |
| `channels.email` | `channels.email` | `email_accounts.rs` |
| `channels.web` | `channels.web` | `onboarding.rs` |
| `tools.exec` | `tools.exec` | (nessuno diretto, via config TUI) |
| `browser` | `browser` | `browser.rs` (4 endpoint) |
| `mcp.servers` | `mcp` | `mcp/crud.rs` (3 endpoint) |
| `providers.*` | `providers` | `providers.rs` (3 endpoint) |
| `storage` | `storage` | (solo CLI) |
| `ui` | `ui` | `onboarding.rs` |

**Approccio**:
1. Aggiungere i section constants in `src/config/mod.rs`
2. Estendere `overlay_db_settings()` con i nuovi match arm
3. Estendere `save_config_section()` con i nuovi match arm
4. Migrare ogni API endpoint da `config.save()` / `state.save_config()` a `state.save_config_section(SECTION_X)`
5. Per i CLI commands (`main.rs` — `config set`, `provider add`, ecc.): passare il DB handle e chiamare `db.set_settings_section()` direttamente

**Goal finale**: `config.toml` diventa SOLO bootstrap per prima installazione. Il DB è l'unica source of truth per tutte le impostazioni runtime. Il TOML continua a essere scritto come backup umano-leggibile.

### 12.2 Altre migliorie future

- **Audit trail grant**: tabella `permission_grants` per tracciare chi ha concesso cosa e quando
- **Revoca grant da UI**: sezione "Granted paths" nella pagina `/permissions`
- **ChoiceBlock per CLI/Telegram**: rendering escalation block su canali non-web (numeric prompt per CLI, inline keyboard per Telegram)
- **`homun doctor` CLI**: comando diagnostico che verifica sandbox, permessi, e DB settings in un colpo

---

## 13. Related Docs

- `docs/features/04-strumenti.md` — Tool Registry, Shell tool, Approval (architettura)
- `docs/features/06-sicurezza.md` § 10 Sandbox Execution, § 12 Permission System
- `docs/SANDBOX-RUNTIME-BASELINE.md` — Docker baseline image + macOS 26 compatibility
- `docs/TRUST-MODEL.md` — Modello di trust generale
