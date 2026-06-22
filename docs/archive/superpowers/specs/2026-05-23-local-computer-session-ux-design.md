# Local Computer Session UX Design

## Context

Durante l'analisi live di Manus abbiamo validato che l'esperienza operativa piu' chiara non e' una dashboard tecnica con inspector sempre aperto. Il modello migliore per il nostro prodotto e':

- chat come superficie primaria.
- navigazione rail-first con drawer espandibile on demand.
- stato del task dentro il thread, non in pannelli densi.
- dettagli tecnici progressivi tramite popover, modal, activity card e panel.
- "computer" visibile come sessione operativa, non come singolo browser.

Manus resta un riferimento UX da studiare, non una base tecnica da copiare. Il nostro sistema resta local-first, con Rust Core owner di policy, audit, scheduling e permessi.

## Goal

Definire il prossimo blocco prodotto/architettura: una Local Computer Session multi-superficie che unifica browser, shell, file/artifact e log sotto lo stesso task durevole.

La sessione deve permettere all'utente di vedere cosa sta facendo l'assistant, intervenire quando serve, approvare azioni rischiose e riprendere task lunghi anche dopo reload, crash o attese di giorni.

## Non-Goals

- Copiare UI, asset o codice di Manus.
- Sostituire il Durable Task Runtime.
- Dare al modello controllo diretto su browser o shell.
- Implementare subito pieno controllo desktop OS.
- Esporre raw prompt, raw tool args, raw shell output, raw browser snapshot o raw payload in UI.
- Usare cloud API per browser, shell, screenshot o orchestrazione.

## Key Decisions

### 1. Computer non significa solo browser

Il "computer" del prodotto e' una sessione locale multi-superficie:

```text
Local Computer Session
  -> Browser Surface
  -> Shell Surface
  -> File / Artifact Surface
  -> Log Surface
  -> Future Desktop Surface
```

Browser automation e shell runner sono viste operative della stessa sessione, non due feature separate.

### 2. Il task runtime possiede la durata

La sessione computer non decide quando partire, quando riprovare o come gestire giorni di durata. Queste responsabilita' restano nel Durable Task Runtime:

- queue.
- priorita'.
- lease/heartbeat.
- retry/backoff.
- waiting time.
- waiting user approval.
- resource governance.
- crash recovery.

### 3. La UI mostra sintesi e progress, non log grezzi

L'utente vede:

- timeline inline nel thread.
- stato attuale sintetico.
- activity card con preview.
- detail panel/modal on demand.
- approvazioni e takeover quando servono.

I log completi restano negli store locali e vengono esposti solo tramite viste redatte.

## Component Model

```text
Tauri React UI
  -> Local Computer read model
  -> Rust Core
    -> Assistant Orchestrator Brain
    -> Durable Task Runtime
    -> Capability Layer
    -> Local Computer Session Manager
      -> Session Store
      -> Surface Event Stream
      -> Preview Frame Store
      -> Redaction Boundary
      -> Takeover Gate
      -> Browser Surface Adapter
      -> Shell Surface Adapter
      -> Artifact Surface Adapter
      -> Log Surface Adapter
```

## Rust Responsibilities

### LocalComputerSessionManager

Responsibilities:

- create and bind a session to `task_id`, `workflow_id`, `user_id` and `workspace_id`.
- maintain surface lifecycle.
- append session events.
- persist preview refs, artifact refs and redacted terminal excerpts.
- materialize UI-safe read models.
- enforce takeover state.
- route approvals back to the Durable Task Runtime.
- expose event stream for Tauri.

Suggested Rust modules:

```text
crates/local-computer-session/
  src/lib.rs
  src/types.rs
  src/store.rs
  src/events.rs
  src/read_model.rs
  src/redaction.rs
  src/policy.rs
  src/takeover.rs
  src/browser_surface.rs
  src/shell_surface.rs
  src/artifact_surface.rs
```

### Browser Surface

Responsibilities:

- wrap `crates/browser-automation`.
- map browser checkpoints to computer events.
- store preview frames as bounded screenshot refs.
- expose current URL, tab label and browser status redacted for UI.
- convert manual blockers into approval or takeover states.

### Shell Surface

Responsibilities:

- execute commands only through a controlled process runner.
- classify commands by risk before execution.
- require approval for write/destructive/network-sensitive commands.
- constrain working directory when task scope provides one.
- redact secrets from stdout/stderr before UI read models.
- keep full transcript only in local audit storage, with retention policy.

The shell surface must not expose an arbitrary free-form terminal to the model. The model can propose commands; Rust validates and executes.

### Artifact Surface

Responsibilities:

- track screenshots, PDFs, downloaded files, generated reports and local outputs.
- expose artifact title, type, size, created time and safe preview refs.
- enforce artifact root confinement.
- block sensitive export unless policy allows it.

## Read Model

Minimum UI-safe snapshot:

```text
computer_session_id
task_id
workflow_id
user_id
workspace_id
status
active_surface
surfaces[]
activity_title
activity_subtitle
progress_current
progress_total
elapsed_seconds
preview_frame_ref
current_url_redacted
terminal_excerpt_redacted
artifact_refs[]
timeline[]
approval_state
takeover_state
risk_level
last_error_redacted
updated_at
```

`timeline[]` item:

```text
event_id
surface
kind
status
title
subtitle_redacted
artifact_refs[]
started_at
completed_at
approval_required
```

The read model must never include:

- raw user prompt.
- raw LLM output.
- raw tool args.
- raw browser DOM snapshot.
- raw terminal transcript.
- secrets or tokens.
- unredacted form fields.

## Event Contract

Events are append-only and scoped by user/workspace/task/session.

Initial event types:

```text
computer_session_started
computer_surface_started
computer_surface_stopped
computer_action_started
computer_action_completed
computer_action_failed
computer_frame_captured
computer_terminal_output
computer_artifact_created
computer_checkpoint_recorded
computer_waiting_approval
computer_approval_resolved
computer_takeover_requested
computer_takeover_started
computer_takeover_completed
computer_session_paused
computer_session_resumed
computer_session_completed
computer_session_failed
```

Events can contain private internal payloads, but read models must be materialized through redaction.

## UX Direction

### Global Shell

- Primary rail is the default state.
- Drawer expands on demand for task/project lists.
- No permanent dense left sidebar as the main experience.
- Bottom settings icon opens settings/modal or dedicated settings area.
- Search, notifications and task menus use lightweight popovers.

### Chat Home

- Central prompt composer.
- Minimal quick actions.
- Local runtime status visible but quiet.
- No dashboard cards above the fold.

### Active Task Thread

- Composer sticky at the bottom of the thread.
- Assistant progress appears inline as timeline steps.
- User messages remain simple bubbles.
- Completed activity shows green/success status and follow-up suggestions.
- Long-running waiting state explains what is needed next.

### Local Computer Activity Card

The card appears near the bottom of the active task and includes:

- preview thumbnail or terminal excerpt.
- surface label: Browser, Terminale, File, Log.
- title such as "Computer locale".
- current action subtitle.
- elapsed time.
- progress `n / total`.
- expand/collapse.
- button/icon for detail panel.
- approval/takeover state when relevant.

### Computer Detail Panel

On demand, the user can open a larger panel/modal with tabs:

- Browser.
- Terminale.
- File.
- Log.

The panel supports:

- inspect preview.
- pause/resume/cancel.
- request takeover.
- approve/reject blocked step.
- copy safe artifact refs.

Manual takeover requires explicit confirmation and visible end state.

### Settings and Plugins

Settings and plugins should follow the Manus/Codex hybrid direction:

- settings as full area or large modal with internal menu.
- plugin/connectors page with feature cards, search, connector rows, skill rows and create menu.
- no nested cards.
- max radius 8px.
- light-first neutral palette with system blue accent.

## Security and Privacy

Rules:

- local-first by default.
- no cloud API required for execution or previews.
- deny-by-default for browser, shell, files and connectors.
- domain privacy policy applies to browser URLs and page context.
- command policy applies to shell.
- artifact root confinement applies to files.
- secrets are redacted before read model materialization.
- high-risk actions require approval before execution.
- manual blockers include login, 2FA, CAPTCHA, payment, booking submit, external send/share, deploy, destructive file operations and credential entry.
- user/workspace scoping is mandatory for session records.

Redaction must happen before data reaches React.

## Testing

Required tests for production slice:

- store migration and session lifecycle tests.
- read model redaction tests for browser URL, form fields, terminal secrets and artifact names.
- event ordering and checkpoint replay tests.
- shell command policy tests for read/write/destructive commands.
- browser surface integration fixture using existing Playwright sidecar.
- task runtime integration test for waiting approval, pause/resume and recovery.
- UI screenshot tests for desktop width, short height and mobile width.
- UI tests that composer stays usable and activity card does not hide messages.
- snapshot tests proving raw payloads are absent from UI read models.

## Definition Of Done

The block is production-ready when:

- browser and shell can run as surfaces of one durable task session.
- the UI can show an activity card and detail panel from read models, not mocks.
- approvals and takeover are persisted and auditable.
- no raw payload reaches frontend read models.
- long-running session state survives reload/restart through task checkpoints.
- resource limits cover `computer_session`, `browser_session` and `shell_process`.
- local-only operation is preserved.
