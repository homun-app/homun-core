# Design — Sandbox policy per-progetto (default globale + override per-workspace)

Data: 2026-07-10. Estende ADR 0023 (sandbox + approval unificati) e la reconciliation
del 2026-07-10 (fence OS incondizionato + assi `sandbox_mode`/`approval_policy` configurabili,
oggi **globali**). Obiettivo: rendere la policy **per-progetto** (e su Personale), con un
**default globale** ereditato quando un progetto non sovrascrive.

## Problema

Oggi `sandbox_mode` e `approval_policy` vivono in `runtime-settings.json` come **valori unici
globali**. `resolved_sandbox_mode()` legge quel valore per ogni thread, a prescindere dal
progetto. Non si può dire "il progetto Homun gira workspace-write, il progetto Cliente-X gira
read-only, Personale danger". Lo stato dell'arte (Codex per-repo, Claude Code project-vs-user
settings, il modello "trust per progetto") è **default globale + override per-progetto**.

## Decisione

**Un default globale + override opzionali per-workspace, risolti per precedenza.** Nessun
secondo store: gli override vivono sul `WorkspaceRecord` esistente (workspaces.json); Personale
è un workspace come gli altri. I chokepoint **non cambiano semantica** — già chiamano
`resolved_sandbox_*(state, thread_id)`, quindi ereditano il per-progetto appena il resolver
diventa workspace-aware.

### Modello dati

`WorkspaceRecord` (workspaces.json) — nuovi campi, tutti `Option` (None = **eredita il default globale**):

```rust
struct WorkspaceRecord {
    id: String,
    name: String,
    folder: Option<String>,
    // ADR 0023 — override policy per-workspace. None su ogni campo = eredita il default globale.
    #[serde(default)] sandbox_mode: Option<String>,        // read-only | workspace-write | danger
    #[serde(default)] approval_policy: Option<String>,     // never | on-request | on-failure | untrusted
    #[serde(default)] writable_roots: Option<Vec<String>>, // Fase 2 — cartelle scrivibili oltre la project root
    #[serde(default)] network_access: Option<bool>,        // Fase 2 — rete per i tool di questo progetto
    #[serde(default)] skill_confirmations: Option<Vec<String>>, // Fase 3 — categorie sensibili SEMPRE confermate qui
}
```

Il **default globale** resta in `runtime-settings.json` (`sandbox_mode`/`approval_policy`
esistenti; Fase 2/3 aggiungono `writable_roots`/`network_access`/`skill_confirmations` di default,
opzionali). Personale, se non ha una riga in workspaces.json, si tratta come un workspace virtuale
con override letti da un record dedicato (o dal default).

### Risoluzione (il cuore)

Per **ogni asse**, precedenza:

```
env override  >  override del workspace del thread (se Some)  >  default globale (runtime-settings)  >  built-in
```

- `fn resolved_sandbox_mode()` → `fn resolved_sandbox_mode(state: &AppState, thread_id: Option<&str>) -> SandboxMode`.
  Risolve il workspace del thread (`workspace_for_thread`, già esistente via `project_root_for_thread`/
  scope del thread), legge `record.sandbox_mode` se Some, altrimenti `load_runtime_settings().sandbox_mode`,
  altrimenti default `workspace-write`. Env `HOMUN_SANDBOX_MODE` resta l'override di test.
- Idem `resolved_approval_policy(state, thread_id)`, `resolved_writable_roots(state, thread_id)`,
  `resolved_network_access(state, thread_id)`, `resolved_skill_confirmations(state, thread_id)`.
- `resolved_sandbox_policy(state, thread_id)` compone `SandboxMode` risolto + root + (Fase 2)
  `writable_roots`/`network_access` risolti → `SandboxPolicy`.

**Invariante di reconciliation preservato:** il fence OS resta incondizionato; nessun `SandboxMode`
per-progetto disattiva il kernel fence. `danger` per-progetto = niente card di conferma in quel
progetto, ma il fence resta. `network_access`/`writable_roots` per-progetto ALLARGANO il fence
in modo controllato (opt-in esplicito del progetto), mai lo rimuovono.

### Chokepoint (cambio minimo)

Tutti i siti già passano `thread_id`: `write_project_file`/`edit_project_file`/`apply_patch_in_project`
(read-only gate), il ramo MCP (`workspace_scoped` + read-only gate appena aggiunto), il ramo Composio,
lo shadow-log, il fence bash (`run_in_project`). Diventano per-progetto **solo cambiando le firme dei
resolver** da `()` a `(state, thread_id)`. Nessuna nuova logica di gating.

### UI — pagina "Sandbox" dedicata (Settings)

Nuova voce nav **Sandbox** (accanto a Model & Runtime / Privacy). Contenuto:

1. **Default** (in alto): i selettori globali attuali (`sandbox_mode`, `approval_policy`; Fase 2:
   writable-folders/rete; Fase 3: conferme skill), rietichettati "Default per tutti i progetti".
   Persistono su `runtime-settings.json` come oggi.
2. **Lista workspace**: Personale + ogni progetto (da workspaces.json). Ogni riga mostra la **policy
   effettiva** con badge chiaro `eredita` vs `override` (es. "Homun · read-only (override)",
   "Cliente-X · workspace-write (eredita)"). Espandendo la riga: i controlli per-asse, ognuno con
   un'opzione esplicita **"Eredita default"** oltre ai valori. L'override persiste sul `WorkspaceRecord`
   via un endpoint `POST /api/workspaces/{id}/policy` (merge parziale, come `set_runtime_settings`).

Copia UI: mantenere la nota reconciliation ("il fence OS resta attivo in ogni modalità — Homun non
disabilita mai del tutto la sandbox"). Per `danger`/`network` copy esplicita sul rischio.

## Fasi (consegna a incrementi gated)

- **Fase 1 (demo-safe):** `sandbox_mode` + `approval_policy` per-workspace + la pagina Sandbox
  (Default + righe workspace con eredita/override per questi 2 assi). Resolver workspace-aware.
  Riusa tutto il gating esistente. Endpoint `POST /api/workspaces/{id}/policy`. Test resolver +
  chokepoint per-progetto + UI-contract.
- **Fase 2:** `writable_roots` + `network_access` per-workspace → confluiscono nella
  `SandboxPolicy::WorkspaceWrite { writable_roots, network_access }` passata al fence OS
  (seatbelt/landlock) e ad `assess_tool_safety`. UI: multi-cartella + toggle rete per riga. Test:
  fence onora writable_roots/network del progetto (integrazione landlock/seatbelt).
- **Fase 3:** `skill_confirmations` per-workspace → si compongono con la skill `ConfirmationPolicy`
  esistente (un progetto può forzare conferma su categorie anche senza skill sensibile attiva). UI:
  checkbox categorie per riga. Test: forza-conferma per-progetto.

## Migrazione / compatibilità

- workspaces.json esistente: i nuovi campi sono `#[serde(default)]` → assenti = `None` = eredita il
  default globale → **comportamento invariato** all'upgrade (nessun progetto cambia policy finché
  l'utente non la sovrascrive esplicitamente).
- `runtime-settings.json` invariato (resta il default globale).
- Nessun ritiro di API: `resolved_*()` diventano `resolved_*(state, thread_id)`; i pochi call-site
  di test passano `None` (= default globale) e restano validi.

## Testing

- **Resolver (per asse):** env > override-workspace > default-globale > built-in (unit).
- **Chokepoint per-progetto:** un thread nel progetto A (read-only) blocca la scrittura; un thread
  nel progetto B (workspace-write) la permette — stesso binario, stesso turno-shape.
- **Ereditarietà:** workspace senza override usa il default globale; cambiare il default globale
  cambia i progetti che ereditano, non quelli con override.
- **UI-contract + electron:** la pagina Sandbox lista i workspace, l'override persiste per-workspace,
  il display eredita-vs-override è corretto, il partial-merge non azzera gli altri campi.
- **Fase 2:** test integrazione fence (landlock/seatbelt) con writable_roots/network per-progetto.
- **Live smoke:** due progetti con modalità diverse, verifica che lo stesso agente si comporti
  diversamente a seconda del progetto del thread.

## Edge case

- **Personale** senza folder (progetto legacy default): override letti da un record Personale
  dedicato; se assente, eredita il default globale.
- **danger per-progetto:** niente card, ma fence OS attivo (invariante). Copy di rischio esplicita.
- **Env override** (`HOMUN_SANDBOX_MODE`): resta il vincitore assoluto (test/CI), sopra ogni progetto.
- **Cambio di progetto a metà thread:** la policy è risolta per-turno dal workspace del thread → coerente.

## Non-goal (YAGNI)

- Nessuna gerarchia di ereditarietà oltre il singolo livello progetto→globale (niente "gruppi di
  progetti").
- Nessun override per-thread (la granularità è il progetto, non la singola chat).
- Nessuna UI di audit-log dei cambi policy (fuori scope; i cambi restano su workspaces.json).
