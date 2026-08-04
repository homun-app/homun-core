# apply_patch — Codex-faithful multi-file structured edit tool

Data: 2026-07-03 (design) · **atterrato sulla linea presentabile 2026-07-09** (`51fd92ca`, 35 test).
Il tool `apply_patch` applica patch multi-file in **formato Codex**
(`*** Begin Patch` … `*** End Patch`). La grammatica è stata estratta **verbatim dal
binario Codex reale** (`codex-cli 0.142.5`). Vedi la
[spec di grammatica](../superpowers/plans/2026-07-03-apply-patch.md) e l'ADR 0023.

> **Gating attuale (post-riconciliazione sandbox):** `apply_patch` passa dallo stesso chokepoint di
> `edit_file`/`write_file`. Sotto `SandboxMode::read-only` (risolto da `resolved_sandbox_policy`)
> `apply_patch_in_project` nega **senza scrivere** e ritorna il marker `SANDBOX_READ_ONLY_BLOCKED`,
> che la UI trasforma nella escalation card (switch-to-workspace-write). Il fence OS resta incondizionato.

## Perché esiste

Codex usa `apply_patch` come **tool-firma** per gli edit: multi-file, per-hunk,
localizzati per **contesto (senza numeri di riga)** — più robusto di `write_file`
(riscrive tutto) o `edit_file` (una sostituzione singola). Portarlo fedelmente allinea
Homun al modo in cui Codex modifica il codice, e **converge** sullo stesso chokepoint di
sicurezza già costruito (non un secondo percorso di scrittura).

## Lo split Codex-fedele: chi fa cosa

- **`apply_patch` possiede parse + context-match + edit.** Non fa confinamento.
- **Il sandbox layer possiede il confinamento.** Ogni path toccato passa per
  `jail_in_root` (rifiuta `..`, path assoluti, escape via symlink); sotto `read-only` il
  tool nega inline. Questo è **identico a Codex** (il suo `apply_patch` delega jail +
  writable-roots al guardian/sandbox).

## Moduli

- **`crates/desktop-gateway/src/apply_patch.rs`** (modulo focalizzato, come
  `seatbelt.rs`/`tool_safety.rs` — converge, non gonfia `main.rs`):
  - `parse_patch(&str) -> Result<Patch, ParseError>` — parser puro della grammatica
    (Add/Update/Delete/Move, `@@` hunk, prefissi `+`/`-`/spazio, `*** End of File`).
  - `compute_changes(&Patch, &read_closure) -> Result<Vec<FileChange>, ApplyError>` —
    applier puro: localizza gli hunk per **match fuzzy 3-passi** (esatto → trim-trailing
    → trim-all), ancorato dalla hint `@@` opzionale; **atomico** (calcola tutto o il primo
    errore); newline preservati; cursore monotòno (hunk in ordine di file, else
    `ContextNotFound`). Fedele a `compute_replacements`/`seek_sequence` di codex-rs.
  - `apply_patch_under_root(input, resolve, read, write, remove)` — bridge testabile:
    risolve **ogni** path (incl. la destinazione `Move`) via `resolve`=`jail_in_root`
    **prima** di scrivere; un fallimento jail aborta senza scrivere nulla.
- **`main.rs`**: `apply_patch_tool_schema()` (arg unico `input`), dispatch in
  `execute_chat_tool` (`spawn_blocking`, `‹‹ACT››`, artifact-memory per file, una
  `‹‹DIFF››` DiffCard per file), gate `read-only` inline.
- **`tool_safety.rs`**: `tool_footprint("apply_patch") = Write` (osservabilità + gate).

## Sicurezza (verificata in review)

Confinamento **airtight**: nessun path raggiunge `fs::write`/`remove_file` senza jail; la
write-phase riusa i `PathBuf` jailed pre-risolti (non ri-deriva dal patch grezzo);
errore parse/apply/jail → aborta, **niente scritto**, nessun falso successo. Test in
memoria provano "jail violation → niente scritto", "Move dest jailed", "ContextNotFound →
niente scritto". Write-phase non-atomica best-effort (stessa garanzia di `write_file`).

## Follow-up noti

- **Escalation read-only per apply_patch**: sotto `read-only` nega senza scrivere e ritorna il marker
  `SANDBOX_READ_ONLY_BLOCKED` → la UI mostra la escalation card **switch-to-workspace-write**. Il
  re-run per-azione (ri-eseguire la scrittura bloccata) è stato **deliberatamente non portato**: richiederebbe
  di ri-veicolare contenuto+provenance della scrittura, un rischio di bypass del chokepoint. Follow-up
  eventuale solo se serve la UX Codex di re-run puntuale.
- **Diff di un Rename**: reso come write(dest)+delete(source) — cosmetico, non un singolo
  "renamed" nella UI.
- **Atomicità write-phase**: write-to-temp + rename atomico è un miglioramento futuro.
