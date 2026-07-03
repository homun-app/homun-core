# Design — Risoluzione unica della SandboxPolicy + enforcement onesto su tutti i tool effettful

Data: 2026-07-03. Implementa il **Pilastro 1 di P1** ([ADR 0023](../../decisions/0023-sandbox-enforcement-and-unified-approval.md)),
passo 4 residuo: "rendere il sandbox onesto" *prima* di esporlo in Settings e flippare il default.
Corrisponde al task **#2** del prompt di ripresa (2026-07-02), riformulato dopo la lettura del codice.

## Problema (verificato sul codice, 2026-07-03)

Il prompt di ripresa descrive il gap come "`write_file`/`edit_file` girano `DangerFullAccess`,
il fence copre solo `run_in_project`". Il codice dice qualcosa di **più profondo**:

- **Nessun tool risolve una `SandboxPolicy` selezionabile.** Il bash fence
  (`run_in_project`, `main.rs:12229`) **hardcoda `workspace_write_roots`** — è *sempre*
  workspace-write quando `HOMUN_TOOL_SAFETY=1`, non guarda nessun setting e **non onora `read-only`**.
- `write_file`/`edit_file` **non** girano DangerFullAccess: `write_project_file`/`edit_project_file`
  (`main.rs:11881`/`11905`) passano *già* per `jail_in_root` → confinati alla project root, *più
  stretti* del fence bash. Ma quel jail è **hardcoded e scollegato dall'asse `SandboxPolicy`**:
  ignora `read-only` (scriverebbe comunque) e non è visibile alla macchina unificata
  footprint→verdict→escalation (`shadow_log_sandbox` classifica ma **solo logga**).
- I rami di approvazione (`emit_approval_card`) calcolano `needs_confirm` con `SandboxPolicy`
  **hardcodata a `DangerFullAccess`**.

L'enum `SandboxPolicy` esiste ed è testato (`tool_safety.rs`), ma **non è mai sorgentato da una
scelta utente**. Quindi "sandbox mode" non è ancora una cosa reale. È il prerequisito che deve
esistere prima che la Settings UI (task #1) significhi qualcosa e prima di poter flippare il default.

## Perché questo, e non "estendi il fence a write_file"

Recintare `write_file`/`edit_file` col kernel è **architetturalmente impossibile**: Seatbelt/Landlock
recintano *sottoprocessi* (`sandbox-exec bash …`, helper Landlock), mentre i file-tool sono
`std::fs::write` **nel processo gateway stesso**, che non è (e non può essere) sandboxato — parla col
modello cloud, apre SQLite, gestisce i sidecar. Lo split è identico a Codex: `apply_patch` fa i
controlli path **in-applicazione**, `shell` gira **sotto Seatbelt**.

Quindi "rendere il fence onesto" per i file-tool non significa recintarli col kernel (già lo fa
`jail_in_root` a livello app, ed è corretto), ma **farli obbedire alla stessa policy** che obbedisce
il fence, **allo stesso chokepoint**, con **la stessa UX di escalation**. Il vero deliverable è
**un'unica sorgente di risoluzione della policy** che *tutti* i tool effettful consultano
(caposaldo #5: una policy, una risoluzione, un chokepoint).

## Decisione

### Asse sandbox (invariato, da ADR 0023)

`read-only` · `workspace-write` · `danger-full-access`. Default spedito = `danger-full-access`
(behavior-preserving); il flip a `workspace-write` è **task #1**, dopo questo lavoro.

### 1. Sorgente unica di risoluzione

Nuovo, in `main.rs` (o modulo `tool_safety`):

```
fn resolved_sandbox_policy(state: &AppState, thread_id: Option<&str>) -> SandboxPolicy
fn resolved_approval_policy() -> AskForApproval
```

Precedenza (mirror di `adaptive_floor_mode`): **env-override > `RuntimeSettings` persistito > default**.

- Env: `HOMUN_TOOL_SAFETY=1` resta come **alias** "enforce workspace-write" (validazioni/test
  esistenti intatti). Nuovo `HOMUN_SANDBOX_MODE=read-only|workspace-write|danger` per controllo fine
  dev. `HOMUN_APPROVAL_POLICY=untrusted|on-failure|on-request|never`.
- Persistito: nuovi campi `sandbox_mode: String` e `approval_policy: String` in `RuntimeSettings`
  (`main.rs:27334`), con `#[serde(default = …)]` + normalizzatori (mirror `normalize_adaptive_floor`).
  **Non** esposti in UI qui — quello è task #1.
- Default: `danger-full-access` / `on-request` → nessun cambio di comportamento finché #1 non flippa.

`workspace-write` risolve i writable-roots via l'esistente `workspace_write_roots(root, HOME)`
(project + cache home) per il **bash**; per i **file-tool** i writable-roots sono **project-only**
(il loro `jail_in_root`, per la decisione least-privilege sotto).

`tool_safety_enabled()` (`main.rs:18623`) diventa **derivato dal solo asse sandbox**:
`resolved_sandbox_policy(..) != DangerFullAccess`. **Deliberatamente NON include l'asse approval**:
col default `danger` + `on-request`, includere l'approval renderebbe `tool_safety_enabled()==true` di
default → enforcement acceso di default, rompendo la behavior-preservation. L'approval policy si
consulta *dentro* il path enforced (quando la sandbox è attiva); a sandbox `danger` (default) il path
legacy boolean di approvazione resta invariato. I call-site esistenti continuano a funzionare.

### 2. Il bash onora la policy risolta

`run_in_project` costruisce la policy da `resolved_sandbox_policy` invece di hardcodare workspace-write:

- `read-only` → fence con **writable-roots vuoti** (profilo Seatbelt/Landlock read-only, kernel-enforced;
  `build_sandbox_command`/`seatbelt_profile`/`landlock_fence` estesi a gestire `ReadOnly`). Scritture negate
  dal kernel → l'escalation on-failure esistente offre "approva → riesegui unsandboxed".
- `workspace-write` → comportamento attuale (project + cache).
- `danger-full-access` → `run_bash_unsandboxed` (l'attuale path flag-off).

Fail-closed invariato: se il fence non si costruisce, il comando **non** gira unsandboxed.

### 3. I file-tool onorano la policy al chokepoint

In `execute_chat_tool`, **prima** di dispatchare `write_file`/`edit_file` (e i filesystem-tool
`create|insert|str_replace` che condividono il path), un gate:

- calcola `tool_footprint(name, args)` (già esiste) → per i write è `Write{path}`;
- consulta `resolved_sandbox_policy`:
  - `read-only` → **nega + `emit_approval_card`** con marker `‹‹SANDBOX_ESCALATE››` che porta
    `{tool, path, content|old+new}` (vedi §5); su approvazione l'endpoint riesegue la scrittura.
  - `workspace-write` / `danger-full-access` → **prosegue** al dispatch attuale.
- l'executor (`write_project_file`/`edit_project_file`) mantiene **`jail_in_root` sempre attivo** →
  project-scoped anche sotto `danger` e anche sulla riesecuzione escalata (difesa-in-profondità +
  decisione semantica sotto).

Promuove `sandbox_shadow_verdict` da osserva→**enforce** **solo** per il footprint `Write`; i footprint
`ReadOnly`/`NonFilesystem`/`Contained` restano no-op (nessun cambio).

**Decisione semantica — file-tool sempre project-scoped (least privilege):** `write_file`/`edit_file`
NON scrivono mai fuori dalla project root, neanche sotto `danger-full-access`. La loro identità è
"modifica file del workspace"; per scrivere altrove c'è `bash` (che sotto `danger` è unsandboxed).
Least-privilege per-tool > permissività uniforme. `jail_in_root` resta incondizionato.

### 4. MCP/Composio — limite onesto, documentato

Footprint `NonFilesystem`/`Contained`: **l'asse sandbox non li recinta** — sono processi esterni /
chiamate di rete, non sottoprocessi che spawniamo sotto il fence (identico a Codex: gli MCP server
girano non-sandboxati). Il loro gate è **l'asse approval**, già cablato via `emit_approval_card`.
Questo design **non** aggiunge enforcement sandbox per loro e lo **scrive esplicitamente** (ADR/spec):
non fingiamo un recinto che non c'è. Sotto `read-only` restano gated dall'approval policy, non dal
sandbox — limitazione nota.

### 5. Escalation esteso alle scritture file

Oggi `POST /api/capabilities/run/escalate` riesegue **solo** bash via `run_bash_unsandboxed`, con gate
provenance `sandbox_escalate_matches` (403 se il comando non combacia col messaggio memorizzato — no RCE).

Esteso: il marker `‹‹SANDBOX_ESCALATE››` per una scrittura porta `{tool: "write_file"|"edit_file",
path, content|old+new}`. `sandbox_escalate_matches` matcha **tool + path + hash del contenuto**.
Su approvazione, l'endpoint riesegue `write_project_file`/`edit_project_file` — che **restano
project-jailed** (la scrittura escalata è comunque confinata al progetto; l'escalation supera il
`read-only`, non il jail).

## Invarianti / caposaldi

- **Una policy, una risoluzione, un chokepoint** (#5). Niente policy sparse per-tool.
- **Policy da codice + settings, mai inferita dal testo del modello** (#2/#6).
- **Behavior-preserving finché #1 non flippa il default** (gated): default `danger` → tutti i path
  identici a oggi; `HOMUN_TOOL_SAFETY=1` → workspace-write come oggi.
- **Local-first/privacy** preservati (#3): il recinto è locale, nessun cloud.

## Testing

- **Unit puri:** precedenza `resolved_sandbox_policy` (env > setting > default) su tutti i casi;
  normalizzatori `sandbox_mode`/`approval_policy`; `sandbox_shadow_verdict` per `Write` sotto i 3 mode
  (read-only=Deny, workspace-write/danger=Allow); `sandbox_escalate_matches` per una scrittura
  (match tool+path+hash, mismatch → reject).
- **Regressione:** i bash-fence runtime test esistenti restano verdi (workspace-write è il default sotto
  `HOMUN_TOOL_SAFETY=1`); i test file-write esistenti verdi (workspace-write/danger invariati).
- **Nuovo comportamento:** `read-only` nega un `write_file` al chokepoint → card escalation emessa;
  approvazione → riesecuzione project-jailed riuscita.
- **Validazione ESEGUENDO** (lezione canonicalizzazione Seatbelt / fence Landlock: il diff+unit non
  bastano): su **macOS** runtime — `read-only` nega davvero una scrittura bash; il profilo read-only
  di Seatbelt si costruisce e nega. Su **Linux** via **CI** (`build.yml` job `landlock-fence`,
  esteso o affiancato) — il fence read-only nega, `--nocapture`, fallisce se NON nega. Windows:
  approval-only, nessun fence (invariato).

## Sequenza (gated, bottom-up)

1. **Fondazione:** campi `RuntimeSettings` + normalizzatori + `resolved_sandbox_policy`/
   `resolved_approval_policy` + `tool_safety_enabled` derivato. Behavior-preserving (default danger).
   Test precedenza. → punto fermo.
2. **Bash:** `run_in_project` usa il resolver; estendi `build_sandbox_command`/profili a `ReadOnly`.
   Validato eseguendo (macOS) + CI (Linux).
3. **File-tool:** gate al chokepoint + `sandbox_shadow_verdict` enforce per `Write`. Test read-only-nega.
4. **Escalation file-write:** estendi marker + `sandbox_escalate_matches` + endpoint. Test provenance.
5. **Doc:** aggiorna `architecture/` (desktop-shell / tool-exec) + nota MCP/Composio; segna ADR 0023
   passo 4 "sandbox onesto" completo; STATO.md.

Poi **task #1** (Settings UI che espone `sandbox_mode`/`approval_policy` + **flip del default** a
`workspace-write`) diventa pulito e onesto.

## Domande aperte (da ADR 0023, non bloccanti per questo lavoro)

- Rete: `workspace-write` deve bloccare la rete non-locale? Follow-up (oggi network-on per npm/git).
- Seatbelt deprecato: piano B macOS a lungo termine.
- Granularità workspace-root vs scoping memoria (`workspace_id`).
