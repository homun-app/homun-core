# Design — Skill confirmation policies dichiarative (ADR 0023 Step 5)

Data: 2026-07-03. Implementa lo **Step 5** dell'[ADR 0023](../../decisions/0023-sandbox-enforcement-and-unified-approval.md)
("confirmation policies dichiarative nelle skill") = **Fase 0.3** della [roadmap Codex-parity](../../roadmap-codex-parity.md).
Chiude l'arco safety dell'ADR 0023 dopo lo 0.1 (asse approval 4-livelli) e lo 0.2 (bundle fence Linux).

## Problema (verificato sul codice, 2026-07-03)

L'ADR promette: una skill può dichiarare *confirmation policies* per categorie sensibili
(`delete`/`financial`/`medical`/`sensitive-data` — il pattern SKILL.md di Codex) che **l'harness
rispetta senza fidarsi del modello**. Oggi quel contratto non esiste:

- **Il frontmatter è parsato ma non consultato all'esecuzione.** `Frontmatter` (`skills.rs:71`)
  riconosce `name`/`description`/`license`/`version`/`allowed-tools`; i campi sono metadata
  read-only per UI/discovery, mai letti al momento del gating.
- **Il gate di approval non conosce le skill.** `execute_chat_tool` (`main.rs:19023`) valuta
  `assess_tool_safety` solo ai siti MCP (~22100) e Composio (~22209), più `sandbox_gate_write`
  per file/apply_patch; la decisione dipende da `approval_policy` + `is_effectful_write`, non da
  quale skill è in gioco.
- **La classificazione di sensibilità esistente è solo statica.** `skill_security::WarningCategory`
  (`skill_security.rs:29`: Destructive/PrivilegeEscalation/SecretAccess/…) è uno scan di pattern
  su SKILL.md + script che produce un risk-score all'installazione; **non è cablata al gating a
  runtime**.

Quindi il modello, se sbaglia o è manipolato mentre esegue una skill "che tocca soldi/salute/dati
sensibili", può compiere azioni effettful senza che l'harness alzi la soglia. Manca il pezzo:
*la skill dichiara il dominio, l'harness forza la conferma*.

## Perché A (tag + force-confirm per-scope) e non B/C

`delete`/`sensitive-data` hanno un segnale concreto (pattern distruttivi, accesso a segreti), ma
`financial`/`medical` sono **categorie semantiche senza segnale OS**: l'harness non può "rilevare"
un'azione finanziaria. Il pattern Codex è quindi **per-scope**, non per-azione: *finché una skill
che dichiara un dominio sensibile è attiva, alza la soglia di conferma sulle sue azioni effettful*.

- **B — mappare le categorie a detector concreti** (wire `WarningCategory` al runtime): preciso per
  le categorie rilevabili, ma `financial`/`medical` ricadono comunque su A, non copre MCP/Composio,
  ed è più codice. **Over-engineering per lo slice 1 (YAGNI).** Resta follow-up.
- **C — cooperativo** (istruzioni nella SKILL.md che dicono al modello di chiedere): **respinto
  dall'ADR** ("senza fidarsi del modello"). Non è enforcement.

**A** è lo SOTA dell'ADR: dichiarativo, harness-enforced, **onesto** (non finge un rilevamento
semantico che non c'è — la categoria è contesto per l'utente, l'enforcement è uniforme sulle azioni
effettful), e **riusa** `emit_approval_card` + la nozione `is_effectful_write` già esistente.

## Design (Approccio A, slice 1)

### 1. Frontmatter → categorie tipizzate
Nuovo campo `sensitive:` in SKILL.md, lista di categorie da un **enum chiuso**:

```yaml
sensitive: [delete, financial, medical, sensitive-data]
```

- `enum SensitiveCategory { Delete, Financial, Medical, SensitiveData }` (in `skills.rs`), con
  `parse` **forgiving** (case-insensitive, accetta `sensitive_data`/`sensitive-data`; token ignoti
  → scartati con warning, non fanno fallire il caricamento — coerente col resto del parser).
- Aggiunto a `Frontmatter` (`Vec<SensitiveCategory>`) + esposto su `SkillSummary`/`SkillDetail`
  (per UI/trasparenza; serializzato come stringhe kebab-case).

### 2. Attivazione (turn-scoped)
Nuovo campo mutabile `active_sensitive: &mut Vec<SensitiveCategory>` su `ChatToolCtx`. Quando il
modello chiama `use_skill(id)` (`main.rs:19949`) e la skill caricata dichiara categorie non vuote,
le si accumula (dedup) in `active_sensitive`. Turn-scoped combacia col design di `ChatToolCtx` (già
per-turn, con campi mutabili threaded nel dispatch loop) e col caso comune (`use_skill` + azioni
effettful nello stesso turn). La persistenza **cross-turn** è un follow-up dichiarato (§Follow-up).

### 3. Enforcement (al chokepoint effettful)
Funzione **pura** di decisione, testabile senza env né stato globale:

```rust
/// Una skill sensibile attiva forza la conferma su QUALSIASI azione effettful,
/// anche sotto una policy che altrimenti non chiederebbe (never/on-request).
fn skill_policy_forces_confirm(active_sensitive: &[SensitiveCategory], is_effectful: bool) -> bool {
    is_effectful && !active_sensitive.is_empty()
}
```

Ai due chokepoint di approval effettful in `execute_chat_tool` (siti **MCP** ~22137 e **Composio**
~22251), `needs_confirm` diventa (shadowing):
`needs_confirm || skill_policy_forces_confirm(ctx.active_sensitive, is_write)`. La card di
`emit_approval_card` gira come sempre; l'azione **non** viene eseguita finché l'utente non conferma —
identico al flusso approval attuale.

Le **read** non sono effettful → non gated: una skill sensibile che fa 10 letture e 1 scrittura
chiede conferma solo sulla scrittura.

**Perché MCP/Composio e non anche file/bash in slice 1.** MCP/Composio sono il chokepoint
**real-world** (connettori pagamenti, API dati-salute) dove le categorie *semantiche*
`financial`/`medical`/`sensitive-data` agiscono e dove **non esiste altra difesa** — è lì che lo
Step 5 aggiunge valore. Le azioni distruttive (`delete`) hanno **già** difese: `run_in_sandbox`
passa lo `skill_security::scan_blobs` (blocca i comandi pericolosi) ed è *contained*; `write_file`/
`edit_file`/`apply_patch` sono *jailed* alla project root con escalation card (asse sandbox). Estendere
il force-confirm anche a questi path è un follow-up dichiarato (§Follow-up), non un buco silenzioso.

### 4. Test (TDD, prima del codice)
- **Parse frontmatter** (`skills.rs`): `sensitive: [delete, financial]` → 2 categorie; alias
  `sensitive_data`; token ignoto scartato; campo assente → vuoto; forma inline vs lista.
- **Decisione pura** `skill_policy_forces_confirm`: (attivo+effettful ⇒ true), (attivo+read ⇒ false),
  (vuoto+effettful ⇒ false). Puro, niente env → non alimenta la classe di flake `env::set_var`.

## Confine onesto & Follow-up (dichiarati, fuori slice 1)
- **Cross-turn stickiness:** una skill sensibile caricata in un turn precedente non resta attiva nei
  turn successivi (richiede stato per-thread nello store). Slice 1 è turn-scoped; l'estensione è un
  follow-up. Conservativo: sotto-copre (non over-confirm perpetuo), non falsa sicurezza.
- **MCP/Composio non recintati a livello OS:** come già documentato nell'ADR, questi tool non sono
  sottoprocessi sotto fence; il loro gate è l'asse approval — che è **esattamente** dove agganciamo
  il force-confirm. Nessun enforcement OS-level nuovo qui.
- **Force-confirm su file/bash effettful:** estendere `skill_policy_forces_confirm` ai path
  `write_file`/`edit_file`/`apply_patch`/`run_in_sandbox` (oggi coperti da jail + scan, non dalla card
  sensibile). Utile soprattutto per rendere `delete` enforced end-to-end via lo Step 5, non solo via
  le difese esistenti.
- **Detector concreti (Approccio B):** wiring di `WarningCategory` per un gating per-azione più fine
  su `delete`/`sensitive-data` resta possibile in seguito, sopra questo scaffold.

## Success
- Una SKILL.md può dichiarare `sensitive: […]`; le categorie sono parsate, esposte e tipizzate.
- Con una skill sensibile attiva nel turn, ogni azione effettful emette una approval card **anche**
  sotto `approval_policy` permissiva, riportando la categoria; le read non sono gated.
- La logica di decisione è coperta da test puri; il parse da test di parsing; nessuna regressione ai
  gate esistenti (behavior-preserving quando nessuna skill sensibile è attiva).
